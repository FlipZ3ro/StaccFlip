// Redeem ¥24 → memecoin via yield247 vault.
// Full integration: Pyth post + Wormhole + meme_nav_vault + auto-close & reclaim rent.
//
// Usage: npm run redeem -- <target_mint> <base_amount> [max_shares] [min_base_out]
//   contoh: npm run redeem -- HnXDnwTa68tRhLRZdJkVRLAeYrUkCYgFgDavtwD1pump 1000
//
// SAFETY:
//   - Selalu cek Tx pertama (post Pyth) berhasil sebelum lanjut redeem
//   - `max_shares` cap di full balance kalau tidak dispesifikkan (auto-protect from over-burn)
import "dotenv/config";

process.on("unhandledRejection", (reason: any) => {
  const msg = String(reason?.message || reason);
  if (/TimeoutError|timed out|ETIMEDOUT|fetch failed/i.test(msg)) return;
  console.error("unhandledRejection:", reason);
});

import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { Wallet } from "@coral-xyz/anchor";
// Dynamic require to avoid ESM/CJS dual-export issues
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver");
const { HermesClient } = require("@pythnetwork/hermes-client");
import bs58 from "bs58";

// ─── KONSTAN ───
const VAULT_PROG = new PublicKey("UxPwSFtLTAGox2SjY4t4nFjCdKxnw9ynmv5NgPsiBm1");
const Y24_MINT = new PublicKey("EcTkNnqKosoPwiAxSSaM4wt7YJTxaHDCNYWvQRgcSVfx");
const PUMP_PROG = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// Adapter accounts per kind (admin-registered, ngga deterministik)
// AdapterKindArg enum (8 variants):
// 0=PumpBondingCurve, 1=PumpAmm, 2=RaydiumLaunchLab, 3=RaydiumCpmm,
// 4=RaydiumAmm, 5=MeteoraDbc, 6=MeteoraDammV1, 7=MeteoraDammV2
const ADAPTERS: Record<number, PublicKey> = {
  0: new PublicKey("8SPDoDitsbAsMProoY1oba7GrPQk6kVuUpDE4gxHfcqy"),  // PumpBondingCurve
  1: new PublicKey("GUa41YnP88MyhX4Uqdz54uRQC5kButQBMQdcv7ba9DG7"),  // PumpAmm
  2: new PublicKey("9aiTs6JzPDE1USWHzTR1n8ZnX1eiPGRtcGfynL961jzz"),  // RaydiumLaunchLab (kind=2 in our scan)
  5: new PublicKey("pot9CYhQPYCZE2Qbd1vKbe1eWD6YQYqUctKmXxA7uPq"),  // MeteoraDbc
};

// PumpSwap constants (untuk adapter kind 1)
const PUMPSWAP_PROG = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMPSWAP_GLOBAL = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");

// Meteora DBC (untuk adapter kind 5)
const METEORA_DBC_PROG = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

// Pyth feed IDs (hex) per quote mint
const PYTH_FEEDS: Record<string, string> = {
  [WSOL.toBase58()]: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  [USDC.toBase58()]: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
};

// Anchor disc: sha256("global:redeem")[..8]
const REDEEM_DISC = new Uint8Array([184, 12, 86, 149, 70, 196, 97, 225]);

const CONFIG_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("meme-nav-config-v4")], VAULT_PROG
)[0];

function deriveVaultState(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("meme-nav-vault"), CONFIG_PDA.toBuffer(), mint.toBuffer()],
    VAULT_PROG
  )[0];
}
function deriveQuoteFeed(quoteMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("meme-nav-quote"), quoteMint.toBuffer()],
    VAULT_PROG
  )[0];
}
function derivePumpBondingCurve(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROG
  )[0];
}

function buildRedeemIx(args: {
  redeemer: PublicKey;
  targetMint: PublicKey;
  memeTokenProgram: PublicKey;
  pythPriceUpdate: PublicKey;
  tokenVault: PublicKey;
  quoteMint: PublicKey;
  adapterKind: number;
  remainingAccounts: PublicKey[];
  baseAmount: bigint;
  maxSharesIn: bigint;
  minBaseOut: bigint;
}): TransactionInstruction {
  const { redeemer, targetMint, memeTokenProgram, pythPriceUpdate, tokenVault,
          quoteMint, adapterKind, remainingAccounts,
          baseAmount, maxSharesIn, minBaseOut } = args;
  const vaultState = deriveVaultState(targetMint);
  const quoteFeed = deriveQuoteFeed(quoteMint);
  const userMemeAta = getAssociatedTokenAddressSync(targetMint, redeemer, false, memeTokenProgram);
  const userShareAta = getAssociatedTokenAddressSync(Y24_MINT, redeemer, false, TOKEN_2022_PROGRAM_ID);
  const adapter = ADAPTERS[adapterKind];
  if (!adapter) throw new Error(`Adapter kind ${adapterKind} belum di-hardcode di ADAPTERS map`);

  const data = Buffer.alloc(32);
  Buffer.from(REDEEM_DISC).copy(data, 0);
  data.writeBigUInt64LE(baseAmount, 8);
  data.writeBigUInt64LE(maxSharesIn, 16);
  data.writeBigUInt64LE(minBaseOut, 24);

  return new TransactionInstruction({
    programId: VAULT_PROG,
    keys: [
      { pubkey: redeemer, isSigner: true, isWritable: true },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: adapter, isSigner: false, isWritable: false },
      { pubkey: vaultState, isSigner: false, isWritable: true },
      { pubkey: targetMint, isSigner: false, isWritable: false },
      { pubkey: Y24_MINT, isSigner: false, isWritable: true },
      { pubkey: userShareAta, isSigner: false, isWritable: true },
      { pubkey: tokenVault, isSigner: false, isWritable: true },
      { pubkey: userMemeAta, isSigner: false, isWritable: true },
      { pubkey: quoteFeed, isSigner: false, isWritable: false },
      { pubkey: pythPriceUpdate, isSigner: false, isWritable: false },
      { pubkey: memeTokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      // Remaining accounts utk adapter (variabel per kind)
      ...remainingAccounts.map(pk => ({ pubkey: pk, isSigner: false, isWritable: false })),
    ],
    data,
  });
}

// Pump.fun (kind 0): remaining = [global, bondingCurve]
function remainingForPumpVCP(mint: PublicKey): PublicKey[] {
  const bc = derivePumpBondingCurve(mint);
  return [PUMP_GLOBAL, bc];
}

// PumpSwap AMM (kind 1): remaining = [global_config, pool, baseVault, quoteVault]
// Optional poolOverride: hardcode pool address (e.g. pool yang dipakai depositor asli)
async function remainingForPumpSwap(
  conn: Connection, mint: PublicKey, poolOverride?: PublicKey
): Promise<PublicKey[]> {
  let pool: PublicKey;
  let d: Buffer;
  if (poolOverride) {
    const info = await conn.getAccountInfo(poolOverride);
    if (!info) throw new Error(`Pool override ${poolOverride.toBase58()} tidak ditemukan`);
    pool = poolOverride;
    d = info.data;
  } else {
    const poolDisc = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
    const accs = await conn.getProgramAccounts(PUMPSWAP_PROG, {
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: bs58.encode(poolDisc) } },
        { memcmp: { offset: 43, bytes: mint.toBase58() } },
      ],
    });
    if (accs.length === 0) throw new Error(`PumpSwap pool tidak ditemukan untuk ${mint.toBase58()}`);
    pool = accs[0].pubkey;
    d = accs[0].account.data;
  }
  const baseVault = new PublicKey(d.subarray(139, 171));
  const quoteVault = new PublicKey(d.subarray(171, 203));
  return [PUMPSWAP_GLOBAL, pool, baseVault, quoteVault];
}

// Meteora DBC (kind 5): remaining = [config, pool, baseVault, quoteVault]
// Also returns the quote_mint dari DBC config
async function remainingForMeteoraDbc(
  conn: Connection, mint: PublicKey
): Promise<{ accounts: PublicKey[]; quoteMint: PublicKey }> {
  const accs = await conn.getProgramAccounts(METEORA_DBC_PROG, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 136, bytes: mint.toBase58() } }],
  });
  if (accs.length === 0) throw new Error(`Meteora DBC pool tidak ditemukan untuk ${mint.toBase58()}`);
  const d = accs[0].account.data;
  const pool = accs[0].pubkey;
  const config = new PublicKey(d.subarray(72, 104));
  const baseVault = new PublicKey(d.subarray(168, 200));
  const quoteVault = new PublicKey(d.subarray(200, 232));
  // Get quote_mint from config
  const configInfo = await conn.getAccountInfo(config);
  const quoteMint = new PublicKey(configInfo!.data.subarray(8, 40));
  return {
    accounts: [config, pool, baseVault, quoteVault],
    quoteMint,
  };
}

async function main() {
  const RPC = process.env.RPC_URL!;
  const payer = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
  const conn = new Connection(RPC, "confirmed");
  console.log("Redeemer:", payer.publicKey.toBase58());

  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: npm run redeem -- <target_mint> <base_amount> [max_shares_in] [min_base_out]");
    console.log("  base_amount: jumlah MEME yang mau diambil (decimal atau raw)");
    console.log("  max_shares_in: maksimum ¥24 yang boleh di-burn (default = full balance)");
    return;
  }

  const targetMint = new PublicKey(args[0]);

  // Token program detection
  const mintInfo = await conn.getAccountInfo(targetMint);
  if (!mintInfo) throw new Error(`mint ${targetMint.toBase58()} tidak ditemukan`);
  const memeTokenProgram = mintInfo.owner;
  const memeDecimals = mintInfo.data.readUInt8(44);
  console.log("meme program:", memeTokenProgram.toBase58().slice(0,8), "| decimals:", memeDecimals);

  // Baca tokenVault & adapterKind dari vault_state account
  const vaultStatePk = deriveVaultState(targetMint);
  const vsInfo = await conn.getAccountInfo(vaultStatePk);
  if (!vsInfo) throw new Error("vault_state tidak terdaftar untuk mint ini");
  // Layout (from bundle parser): 8 disc + 32 config + 32 mint + 32 tokenVault + 16 amount(u128) + 1 adapterKind @ offset 120
  const tokenVault = new PublicKey(vsInfo.data.subarray(72, 104));
  const adapterKind = vsInfo.data[120];
  console.log("token_vault:", tokenVault.toBase58());
  console.log("adapter kind:", adapterKind, "(0=PumpVCP, 1=PumpSwap, 2=DBC, 3=DAMM)");

  // Get remaining accounts based on adapter kind + auto-detect quote mint
  let remainingAccounts: PublicKey[];
  let quoteMint = WSOL;  // default: most adapters quote in wSOL
  if (adapterKind === 0) {
    remainingAccounts = remainingForPumpVCP(targetMint);
  } else if (adapterKind === 1) {
    // Allow env override for pool (e.g. POOL_OVERRIDE=5ixtziL...)
    const poolOverride = process.env.POOL_OVERRIDE
      ? new PublicKey(process.env.POOL_OVERRIDE)
      : undefined;
    remainingAccounts = await remainingForPumpSwap(conn, targetMint, poolOverride);
    if (poolOverride) console.log(`Using pool override: ${poolOverride.toBase58()}`);
  } else if (adapterKind === 5) {
    const r = await remainingForMeteoraDbc(conn, targetMint);
    remainingAccounts = r.accounts;
    quoteMint = r.quoteMint;
  } else {
    throw new Error(`Adapter kind ${adapterKind} belum di-support`);
  }
  console.log("quote mint:", quoteMint.toBase58(), quoteMint.equals(USDC) ? "(USDC)" : quoteMint.equals(WSOL) ? "(wSOL)" : "");
  console.log("remaining accounts:", remainingAccounts.map(p => p.toBase58().slice(0,8)).join(", "));

  // Saldo ¥24
  const userShareAta = getAssociatedTokenAddressSync(Y24_MINT, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const shareBal = await conn.getTokenAccountBalance(userShareAta);
  const userShares = BigInt(shareBal.value.amount);
  console.log("¥24 balance:", shareBal.value.uiAmountString);

  // Parse args
  const baseAmount = args[1].includes(".")
    ? BigInt(Math.floor(Number(args[1]) * 10**memeDecimals))
    : BigInt(args[1]);
  const maxSharesIn = args[2]
    ? (args[2].includes(".") ? BigInt(Math.floor(Number(args[2]) * 1e6)) : BigInt(args[2]))
    : userShares;
  const minBaseOut = args[3] ? BigInt(args[3]) : 0n;

  console.log("base_amount:", baseAmount.toString(), "raw =", Number(baseAmount)/(10**memeDecimals), "MEME");
  console.log("max_shares_in:", maxSharesIn.toString(), "=", Number(maxSharesIn)/1e6, "¥24");
  console.log("min_base_out:", minBaseOut.toString());

  if (maxSharesIn > userShares) throw new Error("max_shares_in > saldo ¥24");

  // Pyth feed (sesuai quote mint adapter)
  const feedHex = PYTH_FEEDS[quoteMint.toBase58()];
  if (!feedHex) throw new Error(`Pyth feed untuk quote ${quoteMint.toBase58()} tidak terkonfigurasi`);

  // Build with PythSolanaReceiver SDK
  console.log("\nFetching Pyth update dari Hermes…");
  const wallet = new Wallet(payer);
  const receiver = new PythSolanaReceiver({ connection: conn, wallet: wallet as any });
  const hermes = new HermesClient("https://hermes.pyth.network", {});
  const update = await hermes.getLatestPriceUpdates([feedHex], { encoding: "base64" });
  if (!update.binary?.data?.length) throw new Error("hermes empty");
  console.log("Hermes update fetched");

  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates(update.binary.data);
  await builder.addPriceConsumerInstructions(async (getPriceAcc: any) => {
    const pythAcc = getPriceAcc(`0x${feedHex}`);
    if (!pythAcc) throw new Error("price update tidak tersedia di builder");
    console.log("  pyth_price_update (fresh):", pythAcc.toBase58());

    // Pastikan user meme ATA ada
    const userMemeAta = getAssociatedTokenAddressSync(
      targetMint, payer.publicKey, false, memeTokenProgram
    );
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userMemeAta, payer.publicKey, targetMint, memeTokenProgram
    );

    const redeemIx = buildRedeemIx({
      redeemer: payer.publicKey,
      targetMint, memeTokenProgram,
      pythPriceUpdate: pythAcc,
      tokenVault, quoteMint, adapterKind, remainingAccounts,
      baseAmount, maxSharesIn, minBaseOut,
    });

    return [
      { instruction: ataIx, signers: [] },
      { instruction: redeemIx, signers: [] },
    ];
  });

  console.log("\nBuilding versioned tx batch…");
  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
  });
  console.log(`Will send ${txs.length} tx (post + redeem + close + reclaim)`);

  // Save SOL balance for delta tracking
  const solBefore = await conn.getBalance(payer.publicKey);
  const memeBeforeAta = getAssociatedTokenAddressSync(targetMint, payer.publicKey, false, memeTokenProgram);
  let memeBefore = 0n;
  try {
    const b = await conn.getTokenAccountBalance(memeBeforeAta);
    memeBefore = BigInt(b.value.amount);
  } catch {}

  // Send all (skipPreflight=true biar tidak race dengan state propagation)
  for (const [i, { tx, signers }] of txs.entries()) {
    if (signers.length > 0) tx.sign(signers);
    tx.sign([payer]);
    const isLastTx = i === txs.length - 1;
    const sig = await conn.sendTransaction(tx, {
      skipPreflight: i > 0,  // TX 1 sim untuk catch error awal; TX 2+ skip biar tidak race
      maxRetries: 3,
    });
    console.log(`  TX ${i+1}/${txs.length} sent: ${sig}`);
    const res = await conn.confirmTransaction(sig, "confirmed");
    if (res.value.err) {
      // Print logs from chain to debug
      try {
        const txInfo = await conn.getTransaction(sig, { encoding: "json", maxSupportedTransactionVersion: 0 });
        console.error(`  TX ${i+1} err logs:`);
        (txInfo?.meta?.logMessages || []).slice(-20).forEach(l => console.error("   ", l));
      } catch {}
      throw new Error(`TX ${i+1} failed: ${JSON.stringify(res.value.err)}`);
    }
    console.log(`  TX ${i+1} confirmed.`);
    // Small delay between tx to allow state propagation
    if (!isLastTx) await new Promise(r => setTimeout(r, 1500));
  }

  // Result
  const solAfter = await conn.getBalance(payer.publicKey);
  let memeAfter = 0n;
  try {
    const b = await conn.getTokenAccountBalance(memeBeforeAta);
    memeAfter = BigInt(b.value.amount);
  } catch {}
  const newShareBal = await conn.getTokenAccountBalance(userShareAta);

  console.log("\n=== HASIL REDEEM ===");
  console.log(`MEME diterima: ${(Number(memeAfter - memeBefore)/(10**memeDecimals))} (raw: ${memeAfter - memeBefore})`);
  console.log(`¥24 dibakar: ${(Number(userShares - BigInt(newShareBal.value.amount))/1e6).toFixed(6)}`);
  console.log(`SOL delta: ${((solAfter - solBefore)/1e9).toFixed(6)} (fee + reclaimed rent)`);
}

main().catch(e => { console.error("FAIL:", e.message?.slice(0,300)); process.exit(1); });

// Simulate redeem ¥24 → target memecoin (tanpa kirim tx).
// Reveal apakah vault pakai last-exit atau spot, dan berapa tokens keluar.
//
// Usage: npm run sim-redeem -- <target_mint> <shares_amount>
//   contoh: npm run sim-redeem -- HnXDnwTa68tRhLRZdJkVRLAeYrUkCYgFgDavtwD1pump 0.5
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

const VAULT_PROG = new PublicKey("UxPwSFtLTAGox2SjY4t4nFjCdKxnw9ynmv5NgPsiBm1");
const Y24_MINT = new PublicKey("EcTkNnqKosoPwiAxSSaM4wt7YJTxaHDCNYWvQRgcSVfx");
const PUMP_PROG = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");

// Hardcoded adapter accounts per kind (from on-chain register_adapter)
const ADAPTERS: Record<number, PublicKey> = {
  0: new PublicKey("8SPDoDitsbAsMProoY1oba7GrPQk6kVuUpDE4gxHfcqy"), // PumpVCP
};
const PYTH_SOL_USD_FEED = new PublicKey("6VLFddQE8Z4h3zrp2S76dgBNV8o3Z2yrD3PcKh3Dsras");
// Anchor sha256("global:redeem")[..8]
const REDEEM_DISC = new Uint8Array([184, 12, 86, 149, 70, 196, 97, 225]);

// Derive PDAs
const config = PublicKey.findProgramAddressSync(
  [Buffer.from("meme-nav-config-v4")], VAULT_PROG
)[0];

function deriveVaultState(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("meme-nav-vault"), config.toBuffer(), mint.toBuffer()],
    VAULT_PROG
  )[0];
}

function deriveQuoteFeed(quoteMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("meme-nav-quote"), quoteMint.toBuffer()],
    VAULT_PROG
  )[0];
}

function deriveAdapter(adapterKind: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("meme-nav-adapter"), Buffer.from([adapterKind])],
    VAULT_PROG
  )[0];
}

async function main() {
  const RPC = process.env.RPC_URL!;
  const payer = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
  const conn = new Connection(RPC, "confirmed");

  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: npm run sim-redeem -- <mint> [base_amount] [max_shares_in]");
    console.log("  base_amount: jumlah MEME yang mau diambil (raw or decimal)");
    console.log("  max_shares_in: maksimum ¥24 yang boleh di-burn (default = full balance)");
    console.log("");
    console.log("Contoh: npm run sim-redeem -- HnXDnwTa68tRhLRZdJkVRLAeYrUkCYgFgDavtwD1pump 1000");
    return;
  }
  const targetMint = new PublicKey(args[0]);

  // Parse vault_state untuk dapat adapter_kind, tokenVault, mint
  const vsPda = deriveVaultState(targetMint);
  console.log("vault_state PDA:", vsPda.toBase58());
  const vsInfo = await conn.getAccountInfo(vsPda);
  if (!vsInfo) throw new Error("vault_state belum register untuk mint ini");
  // Layout: 8 disc + 32 config + 32 mint + 32 tokenVault + 8 amount + 1 adapterKind + 1 enabled + ...
  const vaultMint = new PublicKey(vsInfo.data.subarray(8, 40));
  const mintInState = new PublicKey(vsInfo.data.subarray(40, 72));
  const tokenVault = new PublicKey(vsInfo.data.subarray(72, 104));
  const vaultAmount = vsInfo.data.readBigUInt64LE(104);
  const adapterKind = vsInfo.data.readUInt8(112);
  const enabled = vsInfo.data.readUInt8(113);
  console.log("  mint:", mintInState.toBase58());
  console.log("  tokenVault:", tokenVault.toBase58());
  console.log("  vault holds:", vaultAmount.toString(), "raw");
  console.log("  adapter kind:", adapterKind, "(0=PumpVCP, 1=CPamm, 2=DBC, 3=DAMM)");
  console.log("  enabled:", enabled);

  // User's ¥24 balance
  const userShareAta = getAssociatedTokenAddressSync(Y24_MINT, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const shareBal = await conn.getTokenAccountBalance(userShareAta);
  const userShares = BigInt(shareBal.value.amount);
  console.log("\nYour ¥24 balance:", shareBal.value.uiAmountString);

  // Get meme decimals from mint
  const mintAccInfo = await conn.getAccountInfo(targetMint);
  const memeDecimals = mintAccInfo!.data.readUInt8(44);  // mint layout: ... decimals at offset 44
  console.log("meme decimals:", memeDecimals);

  // Parse base_amount (meme yang mau diambil)
  const baseArg = args[1] ?? "1000";
  let baseAmount: bigint;
  if (baseArg.includes(".")) {
    baseAmount = BigInt(Math.floor(Number(baseArg) * 10**memeDecimals));
  } else baseAmount = BigInt(baseArg);
  console.log("base_amount (mau diambil):", baseAmount.toString(), "raw =",
    Number(baseAmount)/(10**memeDecimals), "MEME");

  // max_shares_in default = full balance
  const maxSharesIn = args[2] ? BigInt(args[2]) : userShares;
  console.log("max_shares_in (cap):", maxSharesIn.toString(), "=", Number(maxSharesIn)/1e6, "¥24");
  const minBaseOut = 0n;

  // Build redeem ix manually
  // Account list from IDL:
  // redeemer (signer), config, adapter, vault_state, meme_mint, share_mint, redeemer_share_account,
  // token_vault, redeemer_token_account, quote_feed, pyth_price_update, meme_token_program, share_token_program

  // Adapter (hardcoded from on-chain register_adapter)
  const adapter = ADAPTERS[adapterKind];
  if (!adapter) throw new Error(`Adapter kind ${adapterKind} belum di-hardcode`);
  console.log("\nadapter:", adapter.toBase58());

  const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
  const quoteFeed = deriveQuoteFeed(WSOL);
  console.log("quote_feed (wSOL):", quoteFeed.toBase58());
  console.log("pyth_price_update (SOL/USD):", PYTH_SOL_USD_FEED.toBase58());

  // Token program — auto-detect from mint owner
  const mintInfo = await conn.getAccountInfo(targetMint);
  const memeTokenProgram = mintInfo!.owner;
  console.log("meme_token_program:", memeTokenProgram.toBase58());

  const userMemeAta = getAssociatedTokenAddressSync(targetMint, payer.publicKey, false, memeTokenProgram);

  // Pump.fun bonding curve PDA (untuk adapter kind 0)
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), targetMint.toBuffer()], PUMP_PROG
  );
  console.log("pump bonding curve:", bondingCurve.toBase58());

  // RedeemArgs: { base_amount: u64, max_shares_in: u64, min_base_out: u64 }
  const data = Buffer.alloc(32);
  Buffer.from(REDEEM_DISC).copy(data, 0);
  data.writeBigUInt64LE(baseAmount, 8);
  data.writeBigUInt64LE(maxSharesIn, 16);
  data.writeBigUInt64LE(minBaseOut, 24);

  const redeemIx = new TransactionInstruction({
    programId: VAULT_PROG,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: adapter, isSigner: false, isWritable: false },
      { pubkey: vsPda, isSigner: false, isWritable: true },
      { pubkey: targetMint, isSigner: false, isWritable: false },
      { pubkey: Y24_MINT, isSigner: false, isWritable: true },
      { pubkey: userShareAta, isSigner: false, isWritable: true },
      { pubkey: tokenVault, isSigner: false, isWritable: true },
      { pubkey: userMemeAta, isSigner: false, isWritable: true },
      { pubkey: quoteFeed, isSigner: false, isWritable: false },
      { pubkey: PYTH_SOL_USD_FEED, isSigner: false, isWritable: false },
      { pubkey: memeTokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      // Remaining accounts untuk adapter pump (kind 0)
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: false },
    ],
    data,
  });

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userMemeAta, payer.publicKey, targetMint, memeTokenProgram
    ),
    redeemIx,
  ];

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);

  console.log("\nSimulating tx…");
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    console.error("SIM ERR:", JSON.stringify(sim.value.err));
    console.log("Logs:");
    (sim.value.logs || []).forEach(l => console.log(" ", l));
  } else {
    console.log("✅ Sim OK, CU:", sim.value.unitsConsumed);
    console.log("Logs:");
    (sim.value.logs || []).forEach(l => console.log(" ", l));
  }
}

main().catch(e => { console.error(e); process.exit(1); });

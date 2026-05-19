// Jual token bonding-curve di program "Flip v2" (9unZr9Ah...).
// Mengikuti pola dari tx X5D8gKjAt... yang berhasil jual token 3UXmidDi.
// Usage:
//   npm run sell -- <mint> [amount]   (amount default = full balance)
//   npm run sell                       (interaktif: cek semua token user di program v2 dan minta konfirmasi)
import "dotenv/config";

process.on("unhandledRejection", (reason: any) => {
  const msg = String(reason?.message || reason);
  if (/TimeoutError|timed out|ETIMEDOUT|fetch failed/i.test(msg)) return;
  console.error("unhandledRejection:", reason);
});

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

// ── KONSTAN program Flip v2 ──
const FLIPv2_PROG = new PublicKey("9unZr9AhShZBhdmF4gLY9qF9AUmqgw8pMoZcKtof1Wfz");
const QUOTE = new PublicKey("6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f");  // stacSOL LST
const FEE_RECIPIENT = new PublicKey("WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb");
const EVENT_AUTH = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")], FLIPv2_PROG
)[0];

// sha256("global:sell")[..8] — diekstrak dari tx X5D8gKjAt
const SELL_DISCRIMINATOR = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);

const deriveGlobal = () =>
  PublicKey.findProgramAddressSync([Buffer.from("global")], FLIPv2_PROG)[0];
const deriveBC = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBytes()], FLIPv2_PROG)[0];

function buildSellIx(args: {
  user: PublicKey;
  mint: PublicKey;
  tokenAmount: bigint;
  minQuoteOutput: bigint;
}) {
  const { user, mint, tokenAmount, minQuoteOutput } = args;
  const global = deriveGlobal();
  const bc = deriveBC(mint);
  const bcTokenAcct = getAssociatedTokenAddressSync(mint, bc, true, TOKEN_PROGRAM_ID);
  const bcQuoteAcct = getAssociatedTokenAddressSync(QUOTE, bc, true, TOKEN_2022_PROGRAM_ID);
  const userTokenAcct = getAssociatedTokenAddressSync(mint, user, false, TOKEN_PROGRAM_ID);
  const userQuoteAcct = getAssociatedTokenAddressSync(QUOTE, user, false, TOKEN_2022_PROGRAM_ID);
  const feeRecipientQuoteAta = getAssociatedTokenAddressSync(QUOTE, FEE_RECIPIENT, true, TOKEN_2022_PROGRAM_ID);

  const data = Buffer.alloc(24);
  Buffer.from(SELL_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(minQuoteOutput, 16);

  return new TransactionInstruction({
    programId: FLIPv2_PROG,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: QUOTE, isSigner: false, isWritable: true },
      { pubkey: bc, isSigner: false, isWritable: true },
      { pubkey: bcTokenAcct, isSigner: false, isWritable: true },
      { pubkey: bcQuoteAcct, isSigner: false, isWritable: true },
      { pubkey: userTokenAcct, isSigner: false, isWritable: true },
      { pubkey: userQuoteAcct, isSigner: false, isWritable: true },
      { pubkey: feeRecipientQuoteAta, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTH, isSigner: false, isWritable: false },
      { pubkey: FLIPv2_PROG, isSigner: false, isWritable: false },
    ],
    data,
  });
}

interface BondingCurve {
  virtualQuoteReserves: bigint;
  virtualTokenReserves: bigint;
  realQuoteReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

function parseBC(data: Buffer): BondingCurve {
  const off = 8;
  return {
    virtualQuoteReserves: data.readBigUInt64LE(off),
    virtualTokenReserves: data.readBigUInt64LE(off + 8),
    realQuoteReserves: data.readBigUInt64LE(off + 16),
    realTokenReserves: data.readBigUInt64LE(off + 24),
    tokenTotalSupply: data.readBigUInt64LE(off + 32),
    complete: data.readUInt8(off + 40) === 1,
  };
}

// Estimasi LST yang akan didapat dari menjual tokenAmount, berdasarkan formula
// AMM x*y=k dengan virtual+real reserves. Identik pum.fun/Flip style.
function estimateSellOutput(bc: BondingCurve, tokenAmount: bigint): bigint {
  const v_token = bc.virtualTokenReserves + bc.realTokenReserves;
  const v_quote = bc.virtualQuoteReserves + bc.realQuoteReserves;
  // x*y=k → newToken = v_token + tokenAmount; newQuote = k/newToken
  const k = v_token * v_quote;
  const newToken = v_token + tokenAmount;
  const newQuote = k / newToken;
  return v_quote - newQuote;  // quote keluar
}

async function main() {
  const RPC = process.env.RPC_URL!;
  const pkRaw = process.env.PRIVATE_KEY!;
  if (!RPC || !pkRaw) throw new Error("RPC_URL & PRIVATE_KEY di .env");

  const payer = Keypair.fromSecretKey(bs58.decode(pkRaw));
  const conn = new Connection(RPC, "confirmed");
  console.log("User:", payer.publicKey.toBase58());

  // Parse args
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: npm run sell -- <mint> [tokenAmount]");
    console.log("       npm run sell -- <mint>                (jual semua saldo)");
    console.log("       npm run sell -- 3UXmidDiEE7qKDEizMpK2kQPkiAeGX3BRCR8YVZLa8jY");
    return;
  }
  const mint = new PublicKey(args[0]);

  // Get user's token balance
  const userTokenAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const tokenInfo = await conn.getAccountInfo(userTokenAta);
  if (!tokenInfo) throw new Error(`Tidak punya ATA untuk mint ${mint.toBase58()}`);
  const tokenBalance = await conn.getTokenAccountBalance(userTokenAta);
  const balance = BigInt(tokenBalance.value.amount);
  const decimals = tokenBalance.value.decimals;
  console.log(`Saldo: ${tokenBalance.value.uiAmountString} (raw: ${balance})`);

  if (balance === 0n) {
    console.log("Saldo 0, tidak ada yang dijual.");
    return;
  }

  // Determine amount
  const tokenAmount = args[1] ? BigInt(args[1]) : balance;
  if (tokenAmount > balance) throw new Error(`Amount ${tokenAmount} > saldo ${balance}`);
  console.log(`Akan jual: ${tokenAmount} raw (${Number(tokenAmount)/(10**decimals)} ${mint.toBase58().slice(0,4)}…)`);

  // Verify bonding curve exists
  const bc = deriveBC(mint);
  const bcInfo = await conn.getAccountInfo(bc);
  if (!bcInfo) throw new Error(`Bonding curve tidak ditemukan untuk mint ini di program ${FLIPv2_PROG.toBase58()}`);
  const bcState = parseBC(bcInfo.data);
  console.log(`BC: realQuote=${bcState.realQuoteReserves} realToken=${bcState.realTokenReserves} complete=${bcState.complete}`);
  if (bcState.complete) {
    console.log("⚠ Bonding curve sudah complete (migrated ke DEX) — gak bisa jual via program ini.");
    return;
  }

  // Estimate output
  const estOutput = estimateSellOutput(bcState, tokenAmount);
  const minQuoteOutput = (estOutput * 95n) / 100n;  // 5% slippage tolerance
  console.log(`Estimated LST output: ${estOutput} raw`);
  console.log(`Min accepted (5% slip): ${minQuoteOutput} raw`);

  // Pastikan user quote ATA ada
  const userQuoteAta = getAssociatedTokenAddressSync(QUOTE, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const feeQuoteAta = getAssociatedTokenAddressSync(QUOTE, FEE_RECIPIENT, true, TOKEN_2022_PROGRAM_ID);
  const [userQuoteExists, feeQuoteExists] = await Promise.all([
    conn.getAccountInfo(userQuoteAta).then(i => !!i),
    conn.getAccountInfo(feeQuoteAta).then(i => !!i),
  ]);

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  ];
  if (!userQuoteExists) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userQuoteAta, payer.publicKey, QUOTE, TOKEN_2022_PROGRAM_ID
  ));
  if (!feeQuoteExists) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, feeQuoteAta, FEE_RECIPIENT, QUOTE, TOKEN_2022_PROGRAM_ID
  ));
  ixs.push(buildSellIx({ user: payer.publicKey, mint, tokenAmount, minQuoteOutput }));

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);

  // Simulate dulu
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    console.error("SIM ERR:", JSON.stringify(sim.value.err));
    console.error("Logs:\n  " + (sim.value.logs?.join("\n  ") || "(none)"));
    throw new Error("Sell simulation failed");
  }
  console.log(`Sim OK, CU consumed: ${sim.value.unitsConsumed}`);

  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  console.log("Sent:", sig);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`\n✅ SELL DONE: https://solscan.io/tx/${sig}`);

  // Print balance baru
  const newBal = await conn.getTokenAccountBalance(userTokenAta);
  const newLst = await conn.getTokenAccountBalance(userQuoteAta);
  console.log(`\nToken saldo: ${newBal.value.uiAmountString}`);
  console.log(`LST saldo:   ${newLst.value.uiAmountString}`);
}

main().catch(e => { console.error(e); process.exit(1); });

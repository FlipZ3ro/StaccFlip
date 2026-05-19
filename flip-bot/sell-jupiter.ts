// Sell token via Jupiter aggregator → SOL/USDC.
// Usage:
//   npm run sell-jup -- <mint> [amount] [slippage_bps] [outMint]
//   contoh: npm run sell-jup -- ESCSpMBrZsU9qnN8wi1YSqb2249qsjo9d4gYjYvejups
//
// Default: jual semua saldo → wSOL, slippage 2% (200 bps), unwrap ke native SOL
import "dotenv/config";

process.on("unhandledRejection", (reason: any) => {
  const msg = String(reason?.message || reason);
  if (/TimeoutError|timed out|fetch failed/i.test(msg)) return;
  console.error("unhandledRejection:", reason);
});

import {
  Connection, Keypair, PublicKey, VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function main() {
  const RPC = process.env.RPC_URL!;
  const payer = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
  const conn = new Connection(RPC, "confirmed");

  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: npm run sell-jup -- <mint> [amount_decimal] [slippage_bps] [outMint]");
    console.log("  amount_decimal: berapa token (default = saldo penuh)");
    console.log("  slippage_bps: 200 (=2%) default");
    console.log("  outMint: target mint, default SOL");
    return;
  }

  const inputMint = new PublicKey(args[0]);
  const slippageBps = Number(args[2] ?? 200);
  const outputMint = args[3] ?? SOL_MINT;

  // Detect token program
  const mintInfo = await conn.getAccountInfo(inputMint);
  if (!mintInfo) throw new Error(`mint ${inputMint.toBase58()} tidak ditemukan`);
  const tokenProgram = mintInfo.owner;
  const decimals = mintInfo.data.readUInt8(44);
  console.log("Mint:", inputMint.toBase58());
  console.log("  program:", tokenProgram.toBase58().slice(0,8), "| decimals:", decimals);

  // Get user balance
  const ata = getAssociatedTokenAddressSync(inputMint, payer.publicKey, false, tokenProgram);
  let balanceRaw = 0n;
  try {
    const b = await conn.getTokenAccountBalance(ata);
    balanceRaw = BigInt(b.value.amount);
    console.log("Balance:", b.value.uiAmountString, "(raw:", balanceRaw + ")");
  } catch {
    throw new Error("Tidak punya ATA / saldo 0");
  }
  if (balanceRaw === 0n) { console.log("Saldo 0"); return; }

  // Parse amount
  let amountRaw: bigint;
  if (!args[1]) amountRaw = balanceRaw;
  else if (args[1].includes(".")) amountRaw = BigInt(Math.floor(Number(args[1]) * (10**decimals)));
  else amountRaw = BigInt(args[1]);
  if (amountRaw > balanceRaw) { console.log("Amount > saldo, cap to balance"); amountRaw = balanceRaw; }
  console.log("Jual:", amountRaw.toString(), "raw =", Number(amountRaw)/(10**decimals));

  // 1) Jupiter quote
  console.log("\nFetching Jupiter quote…");
  const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const quote: any = await fetch(quoteUrl).then(r => r.json());
  if (quote.error) throw new Error("Jupiter quote error: " + quote.error);
  console.log("  outAmount:", quote.outAmount);
  if (outputMint === SOL_MINT) console.log("  → SOL:", (Number(quote.outAmount)/1e9).toFixed(6));
  console.log("  priceImpactPct:", quote.priceImpactPct + "%");
  console.log("  route:", quote.routePlan?.map((p: any) => p.swapInfo?.label).join(" → "));

  // 2) Build swap transaction
  console.log("\nBuilding swap transaction…");
  const swapUrl = "https://lite-api.jup.ag/swap/v1/swap";
  const swapPayload = {
    quoteResponse: quote,
    userPublicKey: payer.publicKey.toBase58(),
    wrapAndUnwrapSol: true,         // unwrap SOL output langsung ke native
    asLegacyTransaction: false,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  };
  const swapRes: any = await fetch(swapUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapPayload),
  }).then(r => r.json());
  if (swapRes.error) throw new Error("Jupiter swap error: " + swapRes.error);
  if (!swapRes.swapTransaction) throw new Error("No swapTransaction in response: " + JSON.stringify(swapRes).slice(0,200));

  // 3) Deserialize, sign, send
  const txBuf = Buffer.from(swapRes.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([payer]);

  // Pre-balance for delta tracking
  const solBefore = await conn.getBalance(payer.publicKey);
  let tokBefore = 0n;
  try { tokBefore = BigInt((await conn.getTokenAccountBalance(ata)).value.amount); } catch {}

  console.log("Sending tx…");
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  console.log("  sig:", sig);
  const res = await conn.confirmTransaction(sig, "confirmed");
  if (res.value.err) throw new Error("Tx failed: " + JSON.stringify(res.value.err));
  console.log("  confirmed.");

  // Results
  const solAfter = await conn.getBalance(payer.publicKey);
  let tokAfter = 0n;
  try { tokAfter = BigInt((await conn.getTokenAccountBalance(ata)).value.amount); } catch {}

  console.log("\n=== HASIL SELL ===");
  console.log(`Token terjual: ${Number(tokBefore - tokAfter)/(10**decimals)}`);
  console.log(`SOL delta: ${((solAfter - solBefore)/1e9).toFixed(6)}`);
  console.log(`Tx: https://solscan.io/tx/${sig}`);
}

main().catch(e => { console.error("FAIL:", e.message?.slice(0,300)); process.exit(1); });

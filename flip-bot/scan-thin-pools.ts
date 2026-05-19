// Scan vault yield247 untuk thin-pool exploits.
// Mirip cara USDC: cari pool PumpSwap yang reserves tipis → vault valuasi rendah → redeem murah.
//
// Strategy: untuk tiap mint kind 1 (PumpAmm) di vault, list semua pool PumpSwap-nya,
//           rank by quote_vault SOL amount (TVL). Yang paling tipis = arb candidate.
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const RPC = process.env.RPC_URL!;
const VAULT_PROG = new PublicKey("UxPwSFtLTAGox2SjY4t4nFjCdKxnw9ynmv5NgPsiBm1");
const CONFIG_PDA = new PublicKey("F4PC38qQeumTUV4iLvsuGNFNqJMaBwbwSex9zXVoBjGJ");
const PUMPSWAP_PROG = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const MINT_VAULT_DISC = "afdc4308250b2c91";
const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const WSOL = "So11111111111111111111111111111111111111112";

async function main() {
  const conn = new Connection(RPC, "confirmed");

  // 1) List all enabled MintVault accounts (config = F4PC38)
  const accs = await conn.getProgramAccounts(VAULT_PROG, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(MINT_VAULT_DISC, "hex")) } },
      { memcmp: { offset: 8, bytes: CONFIG_PDA.toBase58() } },
    ],
  });
  console.log(`Found ${accs.length} MintVault accounts`);

  // Filter: only kind 1 (PumpAmm/PumpSwap), enabled, vault_amount > 0
  const candidates = accs
    .map(a => ({
      pubkey: a.pubkey,
      mint: new PublicKey(a.account.data.subarray(40, 72)),
      vaultAmt: a.account.data.readBigUInt64LE(104),
      adapterKind: a.account.data[120],
      enabled: a.account.data[121] === 1,
    }))
    .filter(x => x.adapterKind === 1 && x.enabled && x.vaultAmt > 0n);

  console.log(`Kind 1 enabled with positive holdings: ${candidates.length}`);
  console.log("\nScanning each mint's PumpSwap pools for thin liquidity…\n");

  // 2) For each candidate mint, find thinnest pool (lowest quote_vault SOL)
  interface ThinResult {
    mint: string;
    vaultAmt: bigint;
    decimals: number;
    pool: string;
    baseVault: string;
    quoteVault: string;
    poolBaseAmt: bigint;
    poolQuoteAmt: bigint;
    quoteUsd: number;
  }
  const thinResults: ThinResult[] = [];

  for (const c of candidates) {
    try {
      const pools = await conn.getProgramAccounts(PUMPSWAP_PROG, {
        commitment: "confirmed",
        filters: [
          { memcmp: { offset: 0, bytes: bs58.encode(POOL_DISC) } },
          { memcmp: { offset: 43, bytes: c.mint.toBase58() } },
        ],
      });

      // For each pool, get quote_vault balance (SOL amount)
      let thinnest: any = null;
      let minQuote = Infinity;
      for (const p of pools.slice(0, 10)) {  // limit to 10 pools per mint for speed
        const d = p.account.data;
        const quoteMintAddr = new PublicKey(d.subarray(75, 107)).toBase58();
        if (quoteMintAddr !== WSOL) continue;  // only wSOL pools matter (since vault uses wSOL feed)
        const quoteVault = new PublicKey(d.subarray(171, 203));
        const baseVault = new PublicKey(d.subarray(139, 171));
        try {
          const qBal = await conn.getTokenAccountBalance(quoteVault);
          const bBal = await conn.getTokenAccountBalance(baseVault);
          const qSol = Number(qBal.value.amount) / 1e9;
          if (qSol < minQuote && qSol > 0) {
            minQuote = qSol;
            thinnest = {
              pool: p.pubkey.toBase58(),
              baseVault: baseVault.toBase58(),
              quoteVault: quoteVault.toBase58(),
              poolBaseAmt: BigInt(bBal.value.amount),
              poolQuoteAmt: BigInt(qBal.value.amount),
              decimals: bBal.value.decimals,
            };
          }
        } catch { /* skip */ }
      }

      if (thinnest) {
        thinResults.push({
          mint: c.mint.toBase58(),
          vaultAmt: c.vaultAmt,
          decimals: thinnest.decimals,
          ...thinnest,
          quoteUsd: (Number(thinnest.poolQuoteAmt) / 1e9) * 200,  // estimate
        });
      }
    } catch (e: any) {
      // skip
    }
  }

  // 3) Rank by potential profit: vault_amt_usd_value / pool_quote_usd
  console.log("\n" + "═".repeat(140));
  console.log("THIN POOL OPPORTUNITIES (rank by arb potential = vault holdings / thin pool TVL)");
  console.log("═".repeat(140));
  console.log(
    "Mint".padEnd(48) +
    "Vault holds".padEnd(20) +
    "Thin pool quote".padEnd(15) +
    "Estim profit"
  );
  console.log("─".repeat(140));

  // Sort by "thin-ness ratio"
  thinResults.sort((a, b) => {
    const aRatio = Number(a.vaultAmt) / Number(a.poolQuoteAmt || 1n);
    const bRatio = Number(b.vaultAmt) / Number(b.poolQuoteAmt || 1n);
    return bRatio - aRatio;
  });

  for (const r of thinResults.slice(0, 20)) {
    const vaultDisplay = Number(r.vaultAmt) / (10 ** r.decimals);
    const poolQuoteSol = Number(r.poolQuoteAmt) / 1e9;
    const poolBaseDisplay = Number(r.poolBaseAmt) / (10 ** r.decimals);
    console.log(
      r.mint.padEnd(48) +
      vaultDisplay.toFixed(4).padEnd(20) +
      `${poolQuoteSol.toFixed(6)} SOL`.padEnd(15) +
      `Pool TVL: ${poolBaseDisplay.toFixed(2)} tok + ${poolQuoteSol.toFixed(6)} SOL`
    );
    console.log("  Pool:".padEnd(11) + r.pool);
  }

  console.log("\n" + "─".repeat(140));
  console.log("ARBITRAGE: pool dengan quoteSol < 0.05 = candidate. Pakai POOL_OVERRIDE=<pool> npm run redeem");
}

main().catch(e => { console.error(e); process.exit(1); });

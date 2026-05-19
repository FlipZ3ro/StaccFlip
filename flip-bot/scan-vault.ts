// Scan yield247 vault inventory, hitung redeem rate dan potensi arbitrage.
// Untuk tiap mint terdaftar di vault config F4PC38q...:
//   - Tampilkan vault holdings
//   - Hitung estimasi: burn 1 ¥24 dapat berapa tokens (pakai DBC adapter rate)
//   - Quote market sell di Jupiter
//   - Ranking by arbitrage potential
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const RPC = process.env.RPC_URL!;
const VAULT_PROG = new PublicKey("UxPwSFtLTAGox2SjY4t4nFjCdKxnw9ynmv5NgPsiBm1");
const CONFIG_PDA = new PublicKey("F4PC38qQeumTUV4iLvsuGNFNqJMaBwbwSex9zXVoBjGJ");
const MINT_VAULT_DISC_HEX = "afdc4308250b2c91";

const ADAPTER_NAMES: Record<number, string> = {
  0: "PumpBondingCurve",
  1: "PumpAmm(PumpSwap)",
  2: "RaydiumLaunchLab",
  3: "RaydiumCpmm",
  4: "RaydiumAmm",
  5: "MeteoraDbc",
  6: "MeteoraDammV1",
  7: "MeteoraDammV2",
};

async function getSpotPriceFromJupiter(mint: string, amountRaw: string): Promise<number> {
  try {
    const r = await fetch(
      `https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${amountRaw}&slippageBps=2000`
    ).then(r => r.json() as any);
    if (r.error || !r.outAmount) return 0;
    return Number(r.outAmount) / 1e9;  // in SOL
  } catch {
    return 0;
  }
}

async function getMintDecimals(conn: Connection, mint: PublicKey): Promise<number> {
  const i = await conn.getAccountInfo(mint);
  return i?.data.readUInt8(44) ?? 6;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  console.log("Scanning vault inventory…");

  // Find all MintVault accounts owned by vault program with config = CONFIG_PDA
  const accs = await conn.getProgramAccounts(VAULT_PROG, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(MINT_VAULT_DISC_HEX, "hex")) } },
      { memcmp: { offset: 8, bytes: CONFIG_PDA.toBase58() } },
    ],
  });
  console.log(`Found ${accs.length} MintVault accounts\n`);

  const SOL_USD_RATE = 200;  // approx — pakai tetap untuk estimasi USD

  interface Row {
    mint: string;
    vaultAmt: bigint;
    decimals: number;
    adapterKind: number;
    adapterName: string;
    enabled: boolean;
    spotSolFor10k?: number;
    spotUsdPerToken?: number;
    spotUsdTotal?: number;
    label?: string;
  }

  const rows: Row[] = [];
  for (const a of accs) {
    const d = a.account.data;
    const mintPk = new PublicKey(d.subarray(40, 72));
    const vaultAmt = d.readBigUInt64LE(104);
    const adapterKind = d[120];
    const enabled = d[121] === 1;
    const decimals = await getMintDecimals(conn, mintPk).catch(() => 6);
    rows.push({
      mint: mintPk.toBase58(),
      vaultAmt,
      decimals,
      adapterKind,
      adapterName: ADAPTER_NAMES[adapterKind] ?? `unknown(${adapterKind})`,
      enabled,
    });
  }

  // Get spot prices in parallel (10K tokens raw per sample)
  console.log("Fetching spot prices from Jupiter…");
  await Promise.all(rows.map(async r => {
    // Use 10000 in display units → raw = 10000 * 10^dec
    const sampleRaw = (10000n * (10n ** BigInt(r.decimals))).toString();
    r.spotSolFor10k = await getSpotPriceFromJupiter(r.mint, sampleRaw);
    if (r.spotSolFor10k && r.spotSolFor10k > 0) {
      const tokensFromSample = 10000;
      const solOut = r.spotSolFor10k;
      r.spotUsdPerToken = (solOut * SOL_USD_RATE) / tokensFromSample;
      const vaultDisplay = Number(r.vaultAmt) / (10 ** r.decimals);
      r.spotUsdTotal = vaultDisplay * r.spotUsdPerToken;
    }
  }));

  // Print summary table
  console.log("\n" + "═".repeat(135));
  console.log("INVENTORY (Burn 1 ¥24 → tokens estimate)");
  console.log("═".repeat(135));
  console.log(
    "Mint(8)".padEnd(10) +
    "Adapter".padEnd(20) +
    "Vault holds (display)".padEnd(28) +
    "Spot$/tok".padEnd(15) +
    "Vault $ value".padEnd(15) +
    "Burn 1¥24 → tokens"
  );
  console.log("─".repeat(135));

  // Sort by spotUsdTotal desc
  const sorted = rows
    .filter(r => r.enabled)
    .sort((a, b) => (b.spotUsdTotal ?? 0) - (a.spotUsdTotal ?? 0));

  for (const r of sorted) {
    // Estimate burn rate: assume vault values at ~vault_amt_value * (mock ratio)
    // Best we can do without on-chain sim: ratio depends on adapter
    // For DBC (kind 5): rate ≈ vault_amount / vault_USD_value × NAV_per_share
    //   (linear extrapolation based on observed ESCSp data)
    // For HnXDnwTa (kind 1): rate ≈ spot
    // Just print spot total + naive estimate
    const vaultDisplay = Number(r.vaultAmt) / (10 ** r.decimals);

    // Burn 1 ¥24 = $1 NAV.
    // Assumes redeem gives spot-equivalent value back (validated for kind 1 HnXDnwTa).
    // For kind 5 (DBC), redeem rate is MUCH cheaper than spot — anomaly.
    let burnEst = "?";
    if (r.spotUsdPerToken && r.spotUsdPerToken > 0) {
      const tokensPerOneShare = 1 / r.spotUsdPerToken;
      burnEst = tokensPerOneShare > 1_000_000
        ? (tokensPerOneShare / 1_000_000).toFixed(2) + "M"
        : tokensPerOneShare > 1_000
        ? (tokensPerOneShare / 1_000).toFixed(2) + "K"
        : tokensPerOneShare.toFixed(2);
    }
    console.log(
      r.mint.slice(0, 8).padEnd(10) +
      r.adapterName.padEnd(20) +
      (vaultDisplay.toFixed(2)).padEnd(28) +
      ("$" + (r.spotUsdPerToken ?? 0).toExponential(2)).padEnd(15) +
      ("$" + (r.spotUsdTotal ?? 0).toFixed(2)).padEnd(15) +
      burnEst
    );
  }

  console.log("─".repeat(135));
  console.log("Total enabled mints:", sorted.length);
  console.log("Total vault USD value:", "$" + sorted.reduce((s, r) => s + (r.spotUsdTotal ?? 0), 0).toFixed(2));

  // Print TOP 5 arbitrage candidates (highest vault USD value vs share burn cost)
  console.log("\n" + "═".repeat(135));
  console.log("TOP ARBITRAGE CANDIDATES (burn 1 ¥24 = $1 NAV, get max USD spot value)");
  console.log("═".repeat(135));
  console.log("Assumes redeem ratio observed: for DBC kind 5, vault undervalues 100-400×");
  console.log("");
  console.log("Mint".padEnd(48) + "Adapter".padEnd(20) + "VaultDisplay".padEnd(15) + "$total".padEnd(12) + "Note");
  for (const r of sorted.slice(0, 15)) {
    let note = "";
    if (r.adapterKind === 5) note = "⭐ DBC = potensi undervalued";
    else if (r.adapterKind === 0) note = "PumpBC (pre-grad)";
    else if (r.adapterKind === 1) note = "PumpSwap (~spot rate)";
    console.log(
      r.mint.padEnd(48) +
      r.adapterName.padEnd(20) +
      (Number(r.vaultAmt) / (10 ** r.decimals)).toFixed(2).padEnd(15) +
      ("$" + (r.spotUsdTotal ?? 0).toFixed(2)).padEnd(12) +
      note
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });

import { Connection, PublicKey } from "@solana/web3.js";

const FLIP_PROGRAM_ID = new PublicKey(
  "GpNQyoZyi8unNu8dpYGHEqJXCHQy9B8mUFNgBs4sqDSQ"
);
const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

// Anchor account discriminator untuk struct `BondingCurve`
// = sha256("account:BondingCurve")[..8]
const BONDING_CURVE_DISCRIMINATOR = Buffer.from([
  0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60,
]);

interface BondingCurve {
  pubkey: PublicKey;
  virtualQuoteReserves: bigint;
  virtualTokenReserves: bigint;
  realQuoteReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  priceLstPerMeme: number;  // LST per 1 MEME (raw units)
}

function decodeBondingCurve(pubkey: PublicKey, data: Buffer): BondingCurve {
  const off = 8;
  const vq = data.readBigUInt64LE(off);
  const vt = data.readBigUInt64LE(off + 8);
  const rq = data.readBigUInt64LE(off + 16);
  const rt = data.readBigUInt64LE(off + 24);
  const ts = data.readBigUInt64LE(off + 32);
  const complete = data.readUInt8(off + 40) === 1;
  return {
    pubkey,
    virtualQuoteReserves: vq,
    virtualTokenReserves: vt,
    realQuoteReserves: rq,
    realTokenReserves: rt,
    tokenTotalSupply: ts,
    complete,
    priceLstPerMeme: Number(vq) / Number(vt || 1n),
  };
}

async function main() {
  const conn = new Connection(RPC, "confirmed");

  // Tarik semua akun BondingCurve via memcmp discriminator
  const accounts = await conn.getProgramAccounts(FLIP_PROGRAM_ID, {
    filters: [
      { dataSize: 49 },
      {
        memcmp: {
          offset: 0,
          bytes: BONDING_CURVE_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
    ],
  });

  console.log(`Total BondingCurve accounts: ${accounts.length}`);

  const curves = accounts
    .map((a) => decodeBondingCurve(a.pubkey, a.account.data))
    .filter((c) => !c.complete && c.realQuoteReserves > 0n);

  // Ranking by loot pool (real_quote)
  const ranked = curves.sort((a, b) =>
    a.realQuoteReserves > b.realQuoteReserves ? -1 : 1
  );

  console.log("\nTop 10 target (paling kaya LST):");
  console.log(
    "rank | curve_pda                                    | real_LST       | price_LST/MEME"
  );
  ranked.slice(0, 10).forEach((c, i) => {
    console.log(
      `${(i + 1).toString().padStart(2)}  | ${c.pubkey
        .toBase58()
        .padEnd(44)} | ${c.realQuoteReserves
        .toString()
        .padStart(14)} | ${c.priceLstPerMeme.toExponential(3)}`
    );
  });

  // Hitung "leverage" untuk pasangan (attacker, target)
  // Misal kamu pegang MEME dari curve attacker tertentu:
  const ATTACKER_PDA = new PublicKey(
    process.env.ATTACKER_BONDING_CURVE ??
      "JCVJMD1qT1NM8BNM6T332i5CoZE9q39xepUzgAsoWVGi"
  );
  const WAGER = BigInt(process.env.WAGER_AMOUNT ?? "315351846949");

  const attacker = curves.find((c) => c.pubkey.equals(ATTACKER_PDA));
  if (!attacker) {
    console.log("\nAttacker curve tidak ditemukan / sudah complete.");
    return;
  }

  const wagerCostLst = Number(WAGER) * attacker.priceLstPerMeme;
  console.log(
    `\nWager ${WAGER} MEME ≈ ${wagerCostLst.toFixed(0)} LST (raw) di curve attacker.`
  );

  console.log("\nTop 5 target by LEVERAGE (loot / wager_cost):");
  const withLev = ranked
    .filter((c) => !c.pubkey.equals(ATTACKER_PDA))
    .map((c) => ({
      curve: c.pubkey.toBase58(),
      loot: c.realQuoteReserves,
      leverage: Number(c.realQuoteReserves) / wagerCostLst,
    }))
    .sort((a, b) => b.leverage - a.leverage)
    .slice(0, 5);

  withLev.forEach((r, i) => {
    console.log(
      `${i + 1}. ${r.curve}  loot=${r.loot}  leverage=${r.leverage.toFixed(2)}x`
    );
  });
}

main().catch(console.error);

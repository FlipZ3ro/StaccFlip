import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

// ════════════════════════════════════════════════════════════════
//  Konstan dari bundle stacflip.app
// ════════════════════════════════════════════════════════════════
const BACKEND = "https://stacc-backend.vercel.app";
const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

const CURVE_LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "GpNQyoZyi8unNu8dpYGHEqJXCHQy9B8mUFNgBs4sqDSQ"
);
const STACC_QUOTE_MINT = new PublicKey(
  "6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f"
);
const EVENT_AUTHORITY = new PublicKey(
  "2m3237w5ModQZ2ZTt9BJo3dNJ2KM8XqWnP8csM8saw2P"
);
const FEE_RECIPIENT = new PublicKey(
  "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb"
);

const FLIP_DISCRIMINATOR = new Uint8Array([
  24, 243, 78, 161, 192, 246, 102, 103,
]);

const GLOBAL_SEED = Buffer.from("global");
const BC_SEED = Buffer.from("bonding-curve");

function deriveGlobal() {
  return PublicKey.findProgramAddressSync(
    [GLOBAL_SEED],
    CURVE_LAUNCHPAD_PROGRAM_ID
  )[0];
}
function deriveBondingCurve(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [BC_SEED, mint.toBytes()],
    CURVE_LAUNCHPAD_PROGRAM_ID
  )[0];
}

interface AutoPick {
  cheapest_source_mint: string;
  cheapest_source_symbol: string;
  highest_tvl_target_mint: string;
  highest_tvl_target_symbol: string;
  default_wager_meme: string;
  estimated_source_lst_cost: string;
  expected_win_payout_lst: string;
  expected_loss_lst: string;
  expected_treasury_cut_lst: string;
  lst_sol_rate: number;
  leverage_bps: string;
  win_payout_capped: boolean;
}

async function fetchAutoPick(wagerSol: number, userPk: string): Promise<AutoPick> {
  const url = `${BACKEND}/auto-pick?wager_sol=${wagerSol}&user_pubkey=${userPk}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`auto-pick failed: ${r.status}`);
  return r.json();
}

function buildFlipIx(args: {
  user: PublicKey;
  attackerMint: PublicKey;
  targetMint: PublicKey;
  randomnessAccount: PublicKey;
  wagerMemeAmount: bigint;
}): TransactionInstruction {
  const { user, attackerMint, targetMint, randomnessAccount, wagerMemeAmount } =
    args;
  const quoteMint = STACC_QUOTE_MINT;
  const global = deriveGlobal();
  const attackerBC = deriveBondingCurve(attackerMint);
  const targetBC = deriveBondingCurve(targetMint);

  const attackerBcTokenAcct = getAssociatedTokenAddressSync(
    attackerMint, attackerBC, true, TOKEN_PROGRAM_ID
  );
  const attackerBcQuoteAcct = getAssociatedTokenAddressSync(
    quoteMint, attackerBC, true, TOKEN_2022_PROGRAM_ID
  );
  const targetBcQuoteAcct = getAssociatedTokenAddressSync(
    quoteMint, targetBC, true, TOKEN_2022_PROGRAM_ID
  );
  const userAttackerAta = getAssociatedTokenAddressSync(
    attackerMint, user, false, TOKEN_PROGRAM_ID
  );
  const userQuoteAta = getAssociatedTokenAddressSync(
    quoteMint, user, false, TOKEN_2022_PROGRAM_ID
  );
  const feeRecipientQuoteAta = getAssociatedTokenAddressSync(
    quoteMint, FEE_RECIPIENT, true, TOKEN_2022_PROGRAM_ID
  );

  const data = Buffer.alloc(16);
  Buffer.from(FLIP_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(wagerMemeAmount, 8);

  return new TransactionInstruction({
    programId: CURVE_LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: attackerMint, isSigner: false, isWritable: false },
      { pubkey: targetMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: attackerBC, isSigner: false, isWritable: true },
      { pubkey: targetBC, isSigner: false, isWritable: true },
      { pubkey: attackerBcTokenAcct, isSigner: false, isWritable: true },
      { pubkey: attackerBcQuoteAcct, isSigner: false, isWritable: true },
      { pubkey: targetBcQuoteAcct, isSigner: false, isWritable: true },
      { pubkey: userAttackerAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: feeRecipientQuoteAta, isSigner: false, isWritable: true },
      { pubkey: randomnessAccount, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: CURVE_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function main() {
  const pkRaw = process.env.PRIVATE_KEY;
  if (!pkRaw) throw new Error("PRIVATE_KEY belum di-set");
  const payer = Keypair.fromSecretKey(bs58.decode(pkRaw));
  const wagerSol = Number(process.env.WAGER_SOL ?? "0.01");
  const minLeverage = Number(process.env.MIN_LEVERAGE ?? "1.5"); // hanya flip kalau leverage cukup +EV

  console.log("User:", payer.publicKey.toBase58());
  console.log("Wager SOL:", wagerSol);

  const pick = await fetchAutoPick(wagerSol, payer.publicKey.toBase58());
  const leverage = Number(pick.leverage_bps) / 10_000;
  const winSol = Number(pick.expected_win_payout_lst) / 1e9 * pick.lst_sol_rate;
  const lossSol = Number(pick.expected_loss_lst) / 1e9 * pick.lst_sol_rate;
  const evSol = 0.5 * winSol - 0.5 * lossSol;

  console.log("─".repeat(50));
  console.log(`Attacker: ${pick.cheapest_source_symbol} (${pick.cheapest_source_mint})`);
  console.log(`Target:   ${pick.highest_tvl_target_symbol} (${pick.highest_tvl_target_mint})`);
  console.log(`Leverage: ${leverage.toFixed(2)}×`);
  console.log(`Win:  +${winSol.toFixed(6)} SOL`);
  console.log(`Loss: -${lossSol.toFixed(6)} SOL`);
  console.log(`EV (50/50): ${evSol >= 0 ? "+" : ""}${evSol.toFixed(6)} SOL`);
  console.log("─".repeat(50));

  if (leverage < minLeverage) {
    console.log(`Leverage ${leverage.toFixed(2)}× < MIN_LEVERAGE ${minLeverage}× — skip.`);
    return;
  }

  // ⚠️ Randomness account: backend tidak return field-nya — kamu harus punya/
  // bikin Switchboard randomness account sendiri (Randomness.create) lalu
  // commit+reveal sebelum/saat tx ini.
  const RANDOMNESS = new PublicKey(
    process.env.RANDOMNESS_ACCOUNT ?? "11111111111111111111111111111111"
  );
  if (RANDOMNESS.equals(SystemProgram.programId)) {
    throw new Error(
      "Set RANDOMNESS_ACCOUNT di .env — buat dulu via Switchboard On-Demand"
    );
  }

  const conn = new Connection(RPC, "confirmed");
  const attackerMint = new PublicKey(pick.cheapest_source_mint);
  const targetMint = new PublicKey(pick.highest_tvl_target_mint);
  const wagerMeme = BigInt(pick.default_wager_meme);

  const userAttackerAta = getAssociatedTokenAddressSync(
    attackerMint, payer.publicKey, false, TOKEN_PROGRAM_ID
  );
  const userQuoteAta = getAssociatedTokenAddressSync(
    STACC_QUOTE_MINT, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
  );

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userAttackerAta, payer.publicKey, attackerMint, TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userQuoteAta, payer.publicKey, STACC_QUOTE_MINT, TOKEN_2022_PROGRAM_ID
    ),
    buildFlipIx({
      user: payer.publicKey,
      attackerMint,
      targetMint,
      randomnessAccount: RANDOMNESS,
      wagerMemeAmount: wagerMeme,
    }),
  ];

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);

  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    console.error("Simulate error:", sim.value.err);
    console.error(sim.value.logs?.slice(-15));
    return;
  }
  console.log("Sim OK, CU:", sim.value.unitsConsumed);

  const sig = await conn.sendTransaction(tx);
  console.log("https://solscan.io/tx/" + sig);
}

main().catch((e) => { console.error(e); process.exit(1); });

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
import { Randomness, AnchorUtils } from "@switchboard-xyz/on-demand";

// ════════════════════════════════════════════════════════════════
//  KONSTAN — diambil PERSIS dari tx 216GudCC…dtCq5
// ════════════════════════════════════════════════════════════════

const FLIP_PROGRAM_ID = new PublicKey(
  "GpNQyoZyi8unNu8dpYGHEqJXCHQy9B8mUFNgBs4sqDSQ"
);
const SWITCHBOARD_PROGRAM_ID = new PublicKey(
  "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv"
);

// PDA global (seed "global")
const GLOBAL_PDA = new PublicKey(
  "6L6tTZEsJMmQ896wzGL2MUbd3Bg3rdboMXxQDQwKzRFN"
);
// fee recipient (authority, dari Global.feeRecipient)
const FEE_RECIPIENT = new PublicKey(
  "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb"
);
// event authority Anchor
const EVENT_AUTHORITY = new PublicKey(
  "2m3237w5ModQZ2ZTt9BJo3dNJ2KM8XqWnP8csM8saw2P"
);

// ─── Mints ───
const QUOTE_MINT = new PublicKey(
  "6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f"
);  // LST (Token-2022)
const ATTACKER_MINT = new PublicKey(
  "9RP1PYntpaw7uTQ7FdGD2Lb5J9fFLcB46qL9LEYGyQyN"
);  // MEME attacker (SPL)
const TARGET_MINT = new PublicKey(
  "4GEjHyyBjAqjtLXmgAuANd7TAMBBJv5jKGJUiv7Vhrsb"
);  // MEME target (SPL)

// ─── Bonding curve PDAs ───
const ATTACKER_BONDING_CURVE = new PublicKey(
  "JCVJMD1qT1NM8BNM6T332i5CoZE9q39xepUzgAsoWVGi"
);
const TARGET_BONDING_CURVE = new PublicKey(
  "CkW6P5cQoymhyMivdtSZNGL7d5CUnqVYcHiNFe9H4JCv"
);
// vault token & quote untuk attacker/target bonding curve
const ATTACKER_BC_TOKEN_ACCT = new PublicKey(
  "8SZGrXDhXP6KnUFRSoKV7o8vuXcyVaeo34MSXRp7Zhnd"
);
const ATTACKER_BC_QUOTE_ACCT = new PublicKey(
  "DqTR89YA9AXeSDiPCZSmKgzV7Ze853pj8csL2rxzxYuD"
);
const TARGET_BC_QUOTE_ACCT = new PublicKey(
  "F5yY3HWw9uNJJSU5Q7dSCE3hNVngnSUQb46yrSwfvutz"
);

// Switchboard randomness account (HARUS milikmu, hasil commit sebelumnya)
const RANDOMNESS_ACCOUNT = new PublicKey(
  process.env.RANDOMNESS_ACCOUNT ??
    "73JG2gjHWQbiK51EJ8DKEg5H7aT6R36AUDDe4LYfnBBJ"
);

// Discriminator FLIP — diverifikasi dari (a) bundle JS stacflip.app dan
// (b) decode data instruksi tx 216GudCC… → [24,243,78,161,192,246,102,103]
const FLIP_DISCRIMINATOR = Buffer.from([
  24, 243, 78, 161, 192, 246, 102, 103,
]);

// ════════════════════════════════════════════════════════════════
//  Helper: bangun instruksi flip
// ════════════════════════════════════════════════════════════════

function buildFlipIx(
  user: PublicKey,
  userAttackerTokenAccount: PublicKey,
  userQuoteAccount: PublicKey,
  feeRecipientQuoteAccount: PublicKey,
  wagerMemeAmount: bigint
): TransactionInstruction {
  const data = Buffer.alloc(16);
  FLIP_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(wagerMemeAmount, 8);

  return new TransactionInstruction({
    programId: FLIP_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: ATTACKER_MINT, isSigner: false, isWritable: false },
      { pubkey: TARGET_MINT, isSigner: false, isWritable: false },
      { pubkey: QUOTE_MINT, isSigner: false, isWritable: false },
      { pubkey: ATTACKER_BONDING_CURVE, isSigner: false, isWritable: true },
      { pubkey: TARGET_BONDING_CURVE, isSigner: false, isWritable: true },
      { pubkey: ATTACKER_BC_TOKEN_ACCT, isSigner: false, isWritable: true },
      { pubkey: ATTACKER_BC_QUOTE_ACCT, isSigner: false, isWritable: true },
      { pubkey: TARGET_BC_QUOTE_ACCT, isSigner: false, isWritable: true },
      { pubkey: userAttackerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userQuoteAccount, isSigner: false, isWritable: true },
      { pubkey: feeRecipientQuoteAccount, isSigner: false, isWritable: true },
      { pubkey: RANDOMNESS_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: FLIP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ════════════════════════════════════════════════════════════════
//  Main
// ════════════════════════════════════════════════════════════════

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const wager = BigInt(process.env.WAGER_AMOUNT ?? "315351846949");
  const pkRaw = process.env.PRIVATE_KEY;
  if (!pkRaw) throw new Error("PRIVATE_KEY belum di-set di .env");

  const connection = new Connection(rpc, "confirmed");
  const payer = Keypair.fromSecretKey(bs58.decode(pkRaw));
  console.log("User:", payer.publicKey.toBase58());
  console.log("Wager:", wager.toString(), "MEME (raw)");

  // ATA user
  const userAttackerAta = getAssociatedTokenAddressSync(
    ATTACKER_MINT,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID            // MEME = SPL biasa
  );
  const userQuoteAta = getAssociatedTokenAddressSync(
    QUOTE_MINT,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID       // LST = Token-2022
  );
  const feeRecipientQuoteAta = getAssociatedTokenAddressSync(
    QUOTE_MINT,
    FEE_RECIPIENT,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // ─── Switchboard: commit + reveal randomness ───
  // Pakai akun randomness yang sudah ada (RANDOMNESS_ACCOUNT) — kalau belum
  // punya, bikin lewat Randomness.create(...) di luar script ini.
  const { program: sbProgram } = await AnchorUtils.loadEnv();
  const randomness = new Randomness(sbProgram, RANDOMNESS_ACCOUNT);

  // 1) Commit (sekali per flip, slot N)
  const commitIx = await randomness.commitIx(await randomness.queueAccount());
  // 2) Reveal (slot N+1)
  const revealIx = await randomness.revealIx();

  // ─── Instruksi pendukung ───
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      userAttackerAta,
      payer.publicKey,
      ATTACKER_MINT,
      TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      userQuoteAta,
      payer.publicKey,
      QUOTE_MINT,
      TOKEN_2022_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      feeRecipientQuoteAta,
      FEE_RECIPIENT,
      QUOTE_MINT,
      TOKEN_2022_PROGRAM_ID
    ),
  ];

  const flipIx = buildFlipIx(
    payer.publicKey,
    userAttackerAta,
    userQuoteAta,
    feeRecipientQuoteAta,
    wager
  );

  // ─── Bangun versioned tx ───
  // Catatan: commit & reveal idealnya di slot berbeda. Untuk MVP kita
  // gabung satu tx — kalau gagal `FlipBadRandomness`, pisah jadi 2 tx.
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    commitIx,
    revealIx,
    ...ataIxs,
    flipIx,
  ];

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);

  // Simulasi dulu biar error kelihatan jelas
  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    console.error("Simulate error:", sim.value.err);
    console.error("Logs:", sim.value.logs);
    return;
  }
  console.log("Simulate OK, CU:", sim.value.unitsConsumed);

  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  console.log("Sig:", sig);
  console.log("Explorer: https://solscan.io/tx/" + sig);

  await connection.confirmTransaction(sig, "confirmed");
  console.log("Confirmed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

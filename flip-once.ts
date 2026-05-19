// Single-tx flip — pakai pola yang sama dengan stacflip.app (tx 216GudCC...).
// Flow: 3 tx total: INIT, COMMIT, REVEAL+ATAs+DEPOSIT+BUY+FLIP. Close opsional.
// Mudah debug karena setiap step jelas.
import "dotenv/config";

process.on("unhandledRejection", (reason: any) => {
  const msg = String(reason?.message || reason);
  if (/TimeoutError|timed out|ETIMEDOUT|fetch failed/i.test(msg)) return;
  console.error("unhandledRejection:", reason);
});

import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
  SystemProgram, AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Randomness, ON_DEMAND_MAINNET_PID } from "@switchboard-xyz/on-demand";
import bs58 from "bs58";

// ── KONSTAN ──
const RPC = process.env.RPC_URL!;
const WAGER_SOL = Number(process.env.WAGER_SOL ?? "0.005");
const ORACLE = new PublicKey(
  process.env.SB_ORACLE ?? "645bCKGspzjizB1CN5h2A5CThoT2MxVTpFCCHhrBjuHN"
);
const QUEUE = new PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w");

const FLIP_PROG = new PublicKey("GpNQyoZyi8unNu8dpYGHEqJXCHQy9B8mUFNgBs4sqDSQ");
const QUOTE = new PublicKey("6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f");
const FEE_RECIPIENT = new PublicKey("WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb");
const EVENT_AUTH = new PublicKey("2m3237w5ModQZ2ZTt9BJo3dNJ2KM8XqWnP8csM8saw2P");
const SHARED_LUT = new PublicKey("HEeCcQnd2JZP8Cu7Prs17JtEGgJj4YXcRddbV8a3us71");

const POOL_PROG = new PublicKey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
const POOL = new PublicKey("E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb");
const POOL_WAUTH = new PublicKey("8x17uKn1xE7djGP1z3BNvqcn8qk84A8RjrxPi8o55no5");
const POOL_RES = new PublicKey("67ZvAvjKVX9ns8YFnMnAxyhPFibxsHJXQZcX3YeViyTP");
const POOL_FEE_ATA = new PublicKey("8NX7sYj8HY4ghrcaVmXY3eXpUXiNdtYhLHjVprjEJzQT");

const BUY_DISC = new Uint8Array([102,6,61,18,1,218,235,234]);
const FLIP_DISC = new Uint8Array([24,243,78,161,192,246,102,103]);

const deriveGlobal = () => PublicKey.findProgramAddressSync([Buffer.from("global")], FLIP_PROG)[0];
const deriveBC = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), m.toBytes()], FLIP_PROG)[0];

// ── INSTRUCTION BUILDERS ──
function ixDeposit(user: PublicKey, lstAta: PublicKey, lamports: bigint) {
  const d = Buffer.alloc(9); d.writeUInt8(14, 0); d.writeBigUInt64LE(lamports, 1);
  return new TransactionInstruction({
    programId: POOL_PROG,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: POOL_WAUTH, isSigner: false, isWritable: false },
      { pubkey: POOL_RES, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: lstAta, isSigner: false, isWritable: true },
      { pubkey: POOL_FEE_ATA, isSigner: false, isWritable: true },
      { pubkey: lstAta, isSigner: false, isWritable: true },
      { pubkey: QUOTE, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ], data: d,
  });
}

function ixBuy(user: PublicKey, mint: PublicKey, tokenAmt: bigint, maxQuote: bigint) {
  const bc = deriveBC(mint);
  const d = Buffer.alloc(24);
  Buffer.from(BUY_DISC).copy(d, 0); d.writeBigUInt64LE(tokenAmt, 8); d.writeBigUInt64LE(maxQuote, 16);
  return new TransactionInstruction({
    programId: FLIP_PROG,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: deriveGlobal(), isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: QUOTE, isSigner: false, isWritable: false },
      { pubkey: bc, isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(mint, bc, true, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(QUOTE, bc, true, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(mint, user, false, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(QUOTE, user, false, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(QUOTE, FEE_RECIPIENT, true, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTH, isSigner: false, isWritable: false },
      { pubkey: FLIP_PROG, isSigner: false, isWritable: false },
    ], data: d,
  });
}

function ixFlip(user: PublicKey, attMint: PublicKey, tgtMint: PublicKey, randPk: PublicKey, wager: bigint) {
  const attBC = deriveBC(attMint);
  const tgtBC = deriveBC(tgtMint);
  const d = Buffer.alloc(16);
  Buffer.from(FLIP_DISC).copy(d, 0); d.writeBigUInt64LE(wager, 8);
  return new TransactionInstruction({
    programId: FLIP_PROG,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: deriveGlobal(), isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: attMint, isSigner: false, isWritable: true },   // ← FIX: flip burn MEME, butuh writable mint
      { pubkey: tgtMint, isSigner: false, isWritable: false },
      { pubkey: QUOTE, isSigner: false, isWritable: false },
      { pubkey: attBC, isSigner: false, isWritable: true },
      { pubkey: tgtBC, isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(attMint, attBC, true, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(QUOTE, attBC, true, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(QUOTE, tgtBC, true, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(attMint, user, false, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(QUOTE, user, false, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(QUOTE, FEE_RECIPIENT, true, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: randPk, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTH, isSigner: false, isWritable: false },
      { pubkey: FLIP_PROG, isSigner: false, isWritable: false },
    ], data: d,
  });
}

async function sendTx(
  conn: Connection, ixs: TransactionInstruction[],
  signers: Keypair[], label: string, luts: any[] = []
) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...ixs,
    ],
  }).compileToV0Message(luts);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  console.log(`  [${label}] tx size: ${tx.serialize().length} bytes`);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  console.log(`  [${label}] sent: ${sig}`);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`  [${label}] confirmed.`);
  return sig;
}

async function waitSlots(conn: Connection, n: number) {
  const start = await conn.getSlot("confirmed");
  while ((await conn.getSlot("confirmed")) - start < n) {
    await new Promise(r => setTimeout(r, 800));
  }
}

async function closeRandomness(
  conn: Connection, payer: Keypair, sbProgram: any, randomnessPk: PublicKey
): Promise<boolean> {
  try {
    const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
    const data: any = await sbProgram.account.randomnessAccountData.fetch(randomnessPk);
    const programState = PublicKey.findProgramAddressSync(
      [Buffer.from("STATE")], sbProgram.programId
    )[0];
    const lutSigner = PublicKey.findProgramAddressSync(
      [Buffer.from("LutSigner"), randomnessPk.toBuffer()], sbProgram.programId
    )[0];
    const [, lut] = AddressLookupTableProgram.createLookupTable({
      authority: lutSigner, payer: lutSigner,
      recentSlot: Number(data.lutSlot.toString()),
    });
    const rewardEscrow = getAssociatedTokenAddressSync(WSOL, randomnessPk, true, TOKEN_PROGRAM_ID);
    const closeIx = await sbProgram.methods.randomnessClose({}).accounts({
      randomness: randomnessPk, rewardEscrow, authority: payer.publicKey,
      programState, systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID, wrappedSolMint: WSOL,
      lut, lutSigner, addressLookupTableProgram: AddressLookupTableProgram.programId,
    }).instruction();
    await sendTx(conn, [closeIx], [payer], "CLOSE");
    return true;
  } catch (e: any) {
    console.warn(`  ⚠ close ${randomnessPk.toBase58().slice(0,8)}…: ${e.message?.slice(0,80)}`);
    return false;
  }
}

async function main() {
  const payer = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
  const conn = new Connection(RPC, "confirmed");
  // Build provider manual — SDK loadProgramFromConnection() bikin keypair acak,
  // wallet kita ke-ignore (BUG di SDK installed)
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const sbProgram = await Program.at(ON_DEMAND_MAINNET_PID, provider);

  console.log("User:", payer.publicKey.toBase58());

  // ─── PRE-DEPOSIT: top up LST kalau saldo kurang, supaya tx flip tidak overflow ───
  {
    const userQuoteAta_ = getAssociatedTokenAddressSync(QUOTE, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const exists = await conn.getAccountInfo(userQuoteAta_, "confirmed");
    let lstBal = 0n;
    if (exists) {
      const tb = await conn.getTokenAccountBalance(userQuoteAta_, "confirmed");
      lstBal = BigInt(tb.value.amount);
    }
    if (lstBal < 30_000_000n) {
      // Hitung deposit dinamis: pakai 50% dari saldo SOL (sisain untuk rent/fees + 1 flip buffer)
      const bal = await conn.getBalance(payer.publicKey, "confirmed");
      const reserve = 20_000_000;  // 0.02 SOL reserve untuk rent randomness + fees
      const available = bal - reserve;
      const depositAmt = Math.max(10_000_000, Math.floor(available * 0.5));  // min 0.01 SOL
      if (available < 10_000_000) {
        throw new Error(`SOL kurang: ${(bal/1e9).toFixed(4)} SOL, butuh min 0.03 untuk flip`);
      }
      console.log(`LST balance ${lstBal} < 30M. Wallet ${(bal/1e9).toFixed(4)} SOL → deposit ${(depositAmt/1e9).toFixed(4)} SOL`);
      const ixs: TransactionInstruction[] = [];
      if (!exists) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, userQuoteAta_, payer.publicKey, QUOTE, TOKEN_2022_PROGRAM_ID
      ));
      ixs.push(ixDeposit(payer.publicKey, userQuoteAta_, BigInt(depositAmt)));
      await sendTx(conn, ixs, [payer], "PRE-DEPOSIT");
    } else {
      console.log(`LST balance ${lstBal} cukup, skip pre-deposit`);
    }
  }

  // 1) Fetch auto-pick
  const pick: any = await fetch(
    `https://stacc-backend.vercel.app/auto-pick?wager_sol=${WAGER_SOL}&user_pubkey=${payer.publicKey.toBase58()}`
  ).then(r => r.json());
  if (!pick.cheapest_source_mint) throw new Error("No pick available");

  const attMint = new PublicKey(pick.cheapest_source_mint);
  const tgtMint = new PublicKey(pick.highest_tvl_target_mint);
  const wager = BigInt(pick.default_wager_meme);
  const lev = Number(pick.leverage_bps) / 10_000;
  console.log(`Pick: ${pick.cheapest_source_symbol} → ${pick.highest_tvl_target_symbol}, leverage ${lev.toFixed(2)}×`);
  console.log(`Wager ${wager} MEME for ${WAGER_SOL} SOL`);

  // 2) TX 1: INIT randomness
  const rngKp = Keypair.generate();
  const [randomness, createIx] = await Randomness.create(sbProgram, rngKp, QUEUE, payer.publicKey);
  console.log("Randomness:", randomness.pubkey.toBase58());
  await sendTx(conn, [createIx], [payer, rngKp], "INIT");

  // 3) TX 2: COMMIT — build manual karena SDK installed ignore oracle override
  const SYSVAR_SLOTHASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
  const commitIx = await (sbProgram as any).methods
    .randomnessCommit({})
    .accounts({
      randomness: randomness.pubkey,
      queue: QUEUE,
      oracle: ORACLE,
      recentSlothashes: SYSVAR_SLOTHASHES,
      authority: payer.publicKey,
    })
    .instruction();
  console.log("Commit oracle (manual):", ORACLE.toBase58().slice(0,8) + "…");
  await sendTx(conn, [commitIx], [payer], "COMMIT");

  // 4) Wait 33 slots
  console.log("Waiting 33 slots...");
  await waitSlots(conn, 33);

  // 5) Fetch reveal ix (retry kalau gateway timeout)
  let revealIx;
  for (let i = 1; i <= 6; i++) {
    try {
      console.log(`Fetching reveal (attempt ${i}/6)...`);
      revealIx = await randomness.revealIx();
      console.log("✓ reveal fetched");
      break;
    } catch (e: any) {
      console.log(`  failed: ${e.message?.slice(0,80)}`);
      if (i < 6) await new Promise(r => setTimeout(r, 3000 + i*2000));
    }
  }
  if (!revealIx) throw new Error("Reveal failed after 6 attempts");

  // 6) Fetch BOTH LUTs
  const luts: any[] = [];
  const sharedLutRes = await conn.getAddressLookupTable(SHARED_LUT, { commitment: "confirmed" });
  if (sharedLutRes.value) {
    luts.push(sharedLutRes.value);
    console.log(`Shared LUT: ${sharedLutRes.value.state.addresses.length} addrs`);
  }
  const rngData: any = await sbProgram.account.randomnessAccountData.fetch(randomness.pubkey);
  const lutSigner = PublicKey.findProgramAddressSync(
    [Buffer.from("LutSigner"), randomness.pubkey.toBuffer()], sbProgram.programId
  )[0];
  const [, rngLutKey] = AddressLookupTableProgram.createLookupTable({
    authority: lutSigner, payer: lutSigner,
    recentSlot: Number(rngData.lutSlot.toString()),
  });
  const rngLutRes = await conn.getAddressLookupTable(rngLutKey, { commitment: "confirmed" });
  if (rngLutRes.value) {
    luts.push(rngLutRes.value);
    console.log(`Rng LUT: ${rngLutRes.value.state.addresses.length} addrs`);
  }

  // 7) TX 3: ALL-IN-ONE — Reveal + (ATAs jika perlu) + Deposit + Buy + Flip
  const userMemeAta = getAssociatedTokenAddressSync(attMint, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const userQuoteAta = getAssociatedTokenAddressSync(QUOTE, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const feeQuoteAta = getAssociatedTokenAddressSync(QUOTE, FEE_RECIPIENT, true, TOKEN_2022_PROGRAM_ID);

  // Cek ATA mana yang sudah ada — skip createIdempotent untuk yang sudah ada
  const [memeExists, quoteExists, feeExists] = await Promise.all([
    conn.getAccountInfo(userMemeAta, "confirmed").then(i => !!i),
    conn.getAccountInfo(userQuoteAta, "confirmed").then(i => !!i),
    conn.getAccountInfo(feeQuoteAta, "confirmed").then(i => !!i),
  ]);

  // Cek saldo LST — kalau cukup, skip DepositSol
  const wagerLamports = BigInt(Math.floor(WAGER_SOL * 1e9));
  const maxQuote = (BigInt(pick.estimated_source_lst_cost) * 12n) / 10n;
  let lstBalance = 0n;
  if (quoteExists) {
    try {
      const tokBal = await conn.getTokenAccountBalance(userQuoteAta, "confirmed");
      lstBalance = BigInt(tokBal.value.amount);
    } catch {}
  }
  const needDeposit = lstBalance < maxQuote;
  console.log(`ATAs: meme=${memeExists} quote=${quoteExists} fee=${feeExists}`);
  console.log(`LST balance: ${lstBalance}, need ≥ ${maxQuote} → deposit: ${needDeposit ? "YES" : "SKIP"}`);

  const ixs: TransactionInstruction[] = [revealIx];
  if (!memeExists) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userMemeAta, payer.publicKey, attMint, TOKEN_PROGRAM_ID
  ));
  if (!quoteExists) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userQuoteAta, payer.publicKey, QUOTE, TOKEN_2022_PROGRAM_ID
  ));
  if (!feeExists) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, feeQuoteAta, FEE_RECIPIENT, QUOTE, TOKEN_2022_PROGRAM_ID
  ));
  if (needDeposit) ixs.push(ixDeposit(payer.publicKey, userQuoteAta, wagerLamports));
  ixs.push(ixBuy(payer.publicKey, attMint, wager, maxQuote));
  ixs.push(ixFlip(payer.publicKey, attMint, tgtMint, randomness.pubkey, wager));

  // Debug: print signers di setiap ix
  for (const [i, ix] of ixs.entries()) {
    const signers = ix.keys.filter(k => k.isSigner).map(k => k.pubkey.toBase58().slice(0,8));
    console.log(`  ix[${i}] program=${ix.programId.toBase58().slice(0,8)} signers=[${signers.join(",")}]`);
  }

  let flipSucceeded = false;
  try {
    const sig = await sendTx(conn, ixs, [payer], "ALL-IN-ONE", luts);
    console.log(`\n✅ FLIP DONE: https://solscan.io/tx/${sig}`);
    flipSucceeded = true;
  } catch (e: any) {
    console.error(`\n❌ Flip failed: ${e.message?.slice(0, 200)}`);
    if (typeof e.getLogs === "function") {
      try {
        const logs = await e.getLogs(conn);
        console.error("Logs:\n  " + logs.join("\n  "));
      } catch {}
    }
  }

  // Auto-close randomness untuk reclaim ~0.003 SOL rent (selalu jalan, sukses atau gagal)
  console.log("\nClosing randomness account…");
  const ok = await closeRandomness(conn, payer, sbProgram, randomness.pubkey);
  if (ok) console.log("💰 reclaimed ~0.003 SOL rent");
  else console.log("⚠ close gagal — rent nyangkut, jalankan 'npm run recover' nanti");

  console.log(`\nDone. Flip ${flipSucceeded ? "succeeded" : "failed"}.`);
}

main().catch(e => { console.error(e); process.exit(1); });

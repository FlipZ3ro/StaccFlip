import "dotenv/config";

// Swallow timer-based unhandled rejections dari Switchboard SDK
// (mereka pakai setTimeout untuk timeout HTTP, kalau gateway slow rejection
// fire async setelah promise sebenarnya udah di-handle). Tanpa ini Node 22 crash.
process.on("unhandledRejection", (reason: any) => {
  const msg = String(reason?.message || reason);
  if (/TimeoutError|timed out|ETIMEDOUT|fetch failed/i.test(msg)) {
    console.warn(`  ⚠ swallowed late rejection: ${msg.slice(0, 80)}`);
    return;
  }
  console.error("unhandledRejection:", reason);
});
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  Randomness,
  AnchorUtils,
  ON_DEMAND_MAINNET_PID,
} from "@switchboard-xyz/on-demand";

// ════════════════════════════════════════════════════════════════
//  KONFIGURASI
// ════════════════════════════════════════════════════════════════
const BACKEND = "https://stacc-backend.vercel.app";
const RPC = process.env.RPC_URL!;
const WAGER_SOL = Number(process.env.WAGER_SOL ?? "0.01");
const MIN_LEVERAGE_X = Number(process.env.MIN_LEVERAGE_X ?? "10");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "5000");
const COMMIT_REVEAL_GAP_SLOTS = Number(process.env.GAP_SLOTS ?? "33");
const REVEAL_RETRY_MAX = Number(process.env.REVEAL_RETRIES ?? "6");
const REVEAL_RETRY_DELAY_MS = Number(process.env.REVEAL_RETRY_DELAY ?? "3000");
const DRY_RUN = process.env.DRY_RUN === "1";

// ─── Konstan program Flip (dari bundle stacflip.app) ───
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

// Switchboard queue (mainnet on-demand)
const SB_QUEUE = new PublicKey(
  process.env.SB_QUEUE ?? "A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w"
);
// Oracle pool yang gateway-nya reachable dari Indonesia (OVH France IPs,
// bukan everstake.one yang sering ETIMEDOUT). Rotasi round-robin tiap flip
// supaya kalau satu down, langsung pakai yang lain. List ini berdasarkan
// observasi flip terbaru — bisa di-override via env SB_ORACLE_LIST=oracle1,oracle2,...
const SB_ORACLE_POOL = (process.env.SB_ORACLE_LIST ?? [
  "645bCKGspzjizB1CN5h2A5CThoT2MxVTpFCCHhrBjuHN",  // 141.95.85.92
  "8ev3ovH86XmD45JU6YhPy6B3ZVZonixLMVGEcw1B6gwC",  // 92.222.100.185
  "5eVyN3Wx88y3d19kvYC9wBhdaZAwNdmKeA3LiXKEm9hH",  // 141.95.98.113
  "31Uys8oYqNAiRUKR9i24qLaG5ninMFuXckpkfV3FaPDp",  // 92.222.100.182
  "5wCwgqgPtFB9jwjZxLVkM717SGaZKmXXpvXYsyLehu69",  // 141.95.126.78
  "48t1JSKsvDkgGHYxNrECg1ejnfmT111sGzwdLEoep7bb",  // 185.172.191.13
].join(",")).split(",").filter(s => s.length > 30).map(s => new PublicKey(s.trim()));
let oracleIdx = 0;
function nextOracle(): PublicKey {
  const o = SB_ORACLE_POOL[oracleIdx % SB_ORACLE_POOL.length];
  oracleIdx++;
  return o;
}
// Shared LUT yang dipakai stacflip frontend (17 addresses: SB/SPL/ATA/dll)
const STACFLIP_SHARED_LUT = new PublicKey(
  "HEeCcQnd2JZP8Cu7Prs17JtEGgJj4YXcRddbV8a3us71"
);

// SPL Stake Pool — untuk konversi SOL → stacSOL (LST quote token)
const POOL_PROGRAM = new PublicKey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
const POOL = new PublicKey("E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb");
const POOL_WITHDRAW_AUTH = new PublicKey("8x17uKn1xE7djGP1z3BNvqcn8qk84A8RjrxPi8o55no5");
const POOL_RESERVE_STAKE = new PublicKey("67ZvAvjKVX9ns8YFnMnAxyhPFibxsHJXQZcX3YeViyTP");
const POOL_MANAGER_FEE_LST_ATA = new PublicKey("8NX7sYj8HY4ghrcaVmXY3eXpUXiNdtYhLHjVprjEJzQT");

// Discriminator buy = sha256("global:buy")[..8] = dari bundle
const BUY_DISCRIMINATOR = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);

const deriveGlobal = () =>
  PublicKey.findProgramAddressSync(
    [GLOBAL_SEED],
    CURVE_LAUNCHPAD_PROGRAM_ID
  )[0];
const deriveBondingCurve = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [BC_SEED, mint.toBytes()],
    CURVE_LAUNCHPAD_PROGRAM_ID
  )[0];

interface AutoPick {
  cheapest_source_mint: string;
  cheapest_source_symbol: string;
  highest_tvl_target_mint: string;
  highest_tvl_target_symbol: string;
  default_wager_meme: string;
  estimated_source_lst_cost: string;
  expected_win_payout_lst: string;
  expected_loss_lst: string;
  lst_sol_rate: number;
  leverage_bps: string;
  win_payout_capped: boolean;
}

async function fetchAutoPick(
  wagerSol: number,
  userPk: string
): Promise<AutoPick | null> {
  try {
    const url = `${BACKEND}/auto-pick?wager_sol=${wagerSol}&user_pubkey=${userPk}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function buildDepositSolIx(user: PublicKey, userLstAta: PublicKey, lamports: bigint) {
  const data = Buffer.alloc(9);
  data.writeUInt8(14, 0);  // DepositSol = ix #14 di SPL Stake Pool
  data.writeBigUInt64LE(lamports, 1);
  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: POOL_WITHDRAW_AUTH, isSigner: false, isWritable: false },
      { pubkey: POOL_RESERVE_STAKE, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userLstAta, isSigner: false, isWritable: true },
      { pubkey: POOL_MANAGER_FEE_LST_ATA, isSigner: false, isWritable: true },
      { pubkey: userLstAta, isSigner: false, isWritable: true }, // referral = self
      { pubkey: STACC_QUOTE_MINT, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildBuyIx(args: {
  user: PublicKey;
  mint: PublicKey;
  tokenAmount: bigint;
  maxQuoteCost: bigint;
}) {
  const { user, mint, tokenAmount, maxQuoteCost } = args;
  const quoteMint = STACC_QUOTE_MINT;
  const global = PublicKey.findProgramAddressSync([GLOBAL_SEED], CURVE_LAUNCHPAD_PROGRAM_ID)[0];
  const bondingCurve = PublicKey.findProgramAddressSync([BC_SEED, mint.toBytes()], CURVE_LAUNCHPAD_PROGRAM_ID)[0];
  const bcTokenAcct = getAssociatedTokenAddressSync(mint, bondingCurve, true, TOKEN_PROGRAM_ID);
  const bcQuoteAcct = getAssociatedTokenAddressSync(quoteMint, bondingCurve, true, TOKEN_2022_PROGRAM_ID);
  const userTokenAcct = getAssociatedTokenAddressSync(mint, user, false, TOKEN_PROGRAM_ID);
  const userQuoteAcct = getAssociatedTokenAddressSync(quoteMint, user, false, TOKEN_2022_PROGRAM_ID);
  const feeRecipientQuoteAta = getAssociatedTokenAddressSync(quoteMint, FEE_RECIPIENT, true, TOKEN_2022_PROGRAM_ID);

  const data = Buffer.alloc(24);
  Buffer.from(BUY_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(maxQuoteCost, 16);

  return new TransactionInstruction({
    programId: CURVE_LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: bcTokenAcct, isSigner: false, isWritable: true },
      { pubkey: bcQuoteAcct, isSigner: false, isWritable: true },
      { pubkey: userTokenAcct, isSigner: false, isWritable: true },
      { pubkey: userQuoteAcct, isSigner: false, isWritable: true },
      { pubkey: feeRecipientQuoteAta, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: CURVE_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildFlipIx(args: {
  user: PublicKey;
  attackerMint: PublicKey;
  targetMint: PublicKey;
  randomnessAccount: PublicKey;
  wagerMemeAmount: bigint;
}) {
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

async function sendTx(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
  lookupTables: any[] = [],
  skipSimulate = false
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...ixs,
    ],
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);

  // Simulate dulu (kecuali skipSimulate=true untuk tx yang depend on tx sebelumnya)
  if (!skipSimulate) {
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) {
      console.error(`  [${label}] SIM ERR:`, JSON.stringify(sim.value.err));
      console.error(`  Logs:\n    ` + (sim.value.logs?.join("\n    ") || "(none)"));
      throw new Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}`);
    }
  }

  try {
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    console.log(`  [${label}] sent: ${sig}`);
    const res = await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight }, "confirmed"
    );
    if (res.value.err) throw new Error(`${label} failed onchain: ${JSON.stringify(res.value.err)}`);
    console.log(`  [${label}] confirmed.`);
    return sig;
  } catch (e: any) {
    if (typeof e.getLogs === "function") {
      try {
        const logs = await e.getLogs(conn);
        console.error(`  [${label}] tx logs:\n    ` + logs.join("\n    "));
      } catch {}
    }
    throw e;
  }
}

async function waitSlots(conn: Connection, n: number) {
  const start = await conn.getSlot("confirmed");
  while (true) {
    const cur = await conn.getSlot("confirmed");
    if (cur - start >= n) return;
    await new Promise((r) => setTimeout(r, 800));
  }
}

// Lacak randomness account yang stuck (init-ed tapi belum di-close) global.
const stuckRandomness = new Set<string>();

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

async function recoverStuck(conn: Connection, payer: Keypair, sbProgram: any) {
  if (stuckRandomness.size === 0) return;
  console.log(`\n🔧 auto-recover: trying ${stuckRandomness.size} stuck account(s)…`);
  const toRetry = [...stuckRandomness];
  for (const pkStr of toRetry) {
    const pk = new PublicKey(pkStr);
    try {
      const info = await conn.getAccountInfo(pk, "confirmed");
      if (!info) { stuckRandomness.delete(pkStr); continue; } // sudah closed somehow
      const ok = await closeRandomness(conn, payer, sbProgram, pk);
      if (ok) {
        stuckRandomness.delete(pkStr);
        console.log(`  💰 reclaimed ${pkStr.slice(0,8)}…`);
      }
    } catch {}
  }
}

async function executeFlip(
  conn: Connection,
  payer: Keypair,
  pick: AutoPick,
  sbProgram: any
) {
  const attackerMint = new PublicKey(pick.cheapest_source_mint);
  const targetMint = new PublicKey(pick.highest_tvl_target_mint);
  const wagerMeme = BigInt(pick.default_wager_meme);

  // Balance pre-check
  const bal = await conn.getBalance(payer.publicKey, "confirmed");
  const balSol = bal / 1e9;
  const needed = WAGER_SOL + 0.012;  // wager + buffer rent/fees
  if (balSol < needed) {
    throw new Error(
      `Saldo SOL kurang: ${balSol.toFixed(4)} < butuh ${needed.toFixed(4)}. Top up wallet dulu.`
    );
  }
  console.log(`  balance: ${balSol.toFixed(4)} SOL`);

  // ─── TX 1: Init randomness (eksplisit pass payer pubkey sbg arg ke-4) ───
  const rngKp = Keypair.generate();
  const [randomness, createIx] = await Randomness.create(
    sbProgram, rngKp, SB_QUEUE, payer.publicKey
  );
  console.log(`  randomness: ${randomness.pubkey.toBase58()}`);
  // mark stuck preemptively — akan dihapus kalau close berhasil
  stuckRandomness.add(randomness.pubkey.toBase58());
  await sendTx(conn, [createIx], [payer, rngKp], "INIT");

  // ─── TX 2: Commit (rotasi oracle dari pool reachable) ───
  const chosenOracle = nextOracle();
  const commitIx = await (randomness as any).commitIx(SB_QUEUE, payer.publicKey, chosenOracle);
  console.log(`  commit pakai oracle ${chosenOracle.toBase58().slice(0,8)}… (${oracleIdx}/${SB_ORACLE_POOL.length})`);
  await sendTx(conn, [commitIx], [payer], "COMMIT");

  // Wait for slot gap
  console.log(`  waiting ${COMMIT_REVEAL_GAP_SLOTS} slots…`);
  const startSlot = await conn.getSlot("confirmed");
  while (true) {
    const cur = await conn.getSlot("confirmed");
    const elapsed = cur - startSlot;
    process.stdout.write(`\r  slots elapsed: ${elapsed}/${COMMIT_REVEAL_GAP_SLOTS}   `);
    if (elapsed >= COMMIT_REVEAL_GAP_SLOTS) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log();

  // ─── TX 3: Reveal + ATAs + Flip ───
  // Switchboard oracle gateway suka lambat (HTTP timeout 2 dtk).
  // Retry beberapa kali sampai signature siap.
  let revealIx;
  let lastErr: any;
  for (let attempt = 1; attempt <= REVEAL_RETRY_MAX; attempt++) {
    try {
      console.log(`  fetching reveal signature from oracle (attempt ${attempt}/${REVEAL_RETRY_MAX})…`);
      revealIx = await randomness.revealIx();
      console.log(`  ✓ reveal fetched on attempt ${attempt}`);
      break;
    } catch (e: any) {
      lastErr = e;
      const msg = e.message || "";
      const isTimeout = /timeout|TimeoutError|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(msg);
      const isMalformed = /encoding overruns|Uint8Array|borsh/i.test(msg);
      const tag = isTimeout ? "(network)" : isMalformed ? "(partial-response)" : "";
      console.log(`  reveal attempt ${attempt}/${REVEAL_RETRY_MAX} failed ${tag}: ${msg.slice(0,80)}`);
      if (attempt < REVEAL_RETRY_MAX) {
        // exponential-ish backoff: 3s → 5s → 8s → 12s → 18s → end
        const delays = [3000, 5000, 8000, 12000, 18000];
        await new Promise(r => setTimeout(r, delays[Math.min(attempt-1, delays.length-1)]));
      }
    }
  }
  if (!revealIx) {
    throw new Error(`Reveal failed after ${REVEAL_RETRY_MAX} attempts: ${lastErr?.message}`);
  }
  const userAttackerAta = getAssociatedTokenAddressSync(
    attackerMint, payer.publicKey, false, TOKEN_PROGRAM_ID
  );
  const userQuoteAta = getAssociatedTokenAddressSync(
    STACC_QUOTE_MINT, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
  );
  const feeRecipientQuoteAta = getAssociatedTokenAddressSync(
    STACC_QUOTE_MINT, FEE_RECIPIENT, true, TOKEN_2022_PROGRAM_ID
  );

  const flipIx = buildFlipIx({
    user: payer.publicKey,
    attackerMint, targetMint,
    randomnessAccount: randomness.pubkey,
    wagerMemeAmount: wagerMeme,
  });

  // Fetch LUTs untuk compress accounts (tx > 1232 byte tanpa LUT)
  const lookupTables: any[] = [];

  // 1) Shared LUT stacflip (17 addrs: SB program, SPL, ATA, dll)
  try {
    const sharedRes = await conn.getAddressLookupTable(STACFLIP_SHARED_LUT, { commitment: "confirmed" });
    if (sharedRes.value) {
      lookupTables.push(sharedRes.value);
      console.log(`  using SHARED LUT (${sharedRes.value.state.addresses.length} addrs)`);
    }
  } catch (e: any) {
    console.log(`  ⚠ shared LUT fetch failed: ${e.message?.slice(0,60)}`);
  }

  // 2) Per-randomness LUT (kecil tapi tetap berguna)
  try {
    const data: any = await (sbProgram as any).account.randomnessAccountData.fetch(randomness.pubkey);
    const lutSigner = PublicKey.findProgramAddressSync(
      [Buffer.from("LutSigner"), randomness.pubkey.toBuffer()],
      (sbProgram as any).programId
    )[0];
    const [, lutKey] = AddressLookupTableProgram.createLookupTable({
      authority: lutSigner, payer: lutSigner,
      recentSlot: Number(data.lutSlot.toString()),
    });
    const lutRes = await conn.getAddressLookupTable(lutKey, { commitment: "confirmed" });
    if (lutRes.value) {
      lookupTables.push(lutRes.value);
      console.log(`  using RNG LUT ${lutKey.toBase58().slice(0,8)}… (${lutRes.value.state.addresses.length} addrs)`);
    }
  } catch (e: any) {
    console.log(`  ⚠ RNG LUT fetch failed: ${e.message?.slice(0,60)}`);
  }

  // Deposit SOL → LST → Buy MEME (split jadi tx terpisah dari reveal+flip
  // karena 1 tx semua > 1232 byte walau pakai LUT)
  const wagerLamports = BigInt(Math.floor(WAGER_SOL * 1e9));
  const maxQuoteCost = (BigInt(pick.estimated_source_lst_cost) * 12n) / 10n;

  console.log(`  TX 3a: buy ${wagerMeme} ${pick.cheapest_source_symbol} for max ${maxQuoteCost} LST (deposit ${wagerLamports} lamports)`);

  // ─── TX 3a: ATAs + DepositSol + Buy MEME ───
  await sendTx(
    conn,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, userAttackerAta, payer.publicKey, attackerMint, TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, userQuoteAta, payer.publicKey, STACC_QUOTE_MINT, TOKEN_2022_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, feeRecipientQuoteAta, FEE_RECIPIENT, STACC_QUOTE_MINT, TOKEN_2022_PROGRAM_ID
      ),
      buildDepositSolIx(payer.publicKey, userQuoteAta, wagerLamports),
      buildBuyIx({
        user: payer.publicKey, mint: attackerMint,
        tokenAmount: wagerMeme, maxQuoteCost,
      }),
    ],
    [payer],
    "BUY",
    lookupTables
  );

  // Tunggu ATA & MEME muncul di chain (sim race protection)
  console.log(`  waiting for MEME balance to appear on-chain…`);
  for (let i = 0; i < 10; i++) {
    try {
      const ataInfo = await conn.getAccountInfo(userAttackerAta, "confirmed");
      if (ataInfo) {
        console.log(`  ✓ MEME ATA confirmed (slot ${(await conn.getSlot("confirmed"))})`);
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  // ─── TX 3b: Reveal + Flip (skip sim biar tidak race) ───
  const flipSig = await sendTx(
    conn,
    [revealIx, flipIx],
    [payer],
    "REVEAL+FLIP",
    lookupTables,
    true  // skipSimulate
  );

  // ─── TX 4: Close randomness account untuk reclaim rent ───
  const ok = await closeRandomness(conn, payer, sbProgram, randomness.pubkey);
  if (ok) {
    stuckRandomness.delete(randomness.pubkey.toBase58());
    console.log(`  💰 reclaimed ~0.00334 SOL rent`);
  } else {
    console.log(`  ⚠ close gagal — akan auto-recover di poll berikutnya`);
  }

  return flipSig;
}

async function main() {
  if (!RPC) throw new Error("RPC_URL belum di-set");
  const pkRaw = process.env.PRIVATE_KEY;
  if (!pkRaw) throw new Error("PRIVATE_KEY belum di-set");

  if (pkRaw.includes("your_") || pkRaw.length < 80) {
    throw new Error(
      "PRIVATE_KEY di .env masih placeholder atau format salah. " +
      "Harus berupa string base58 ~87-88 karakter (export dari Phantom/Solflare 'Base58' format), " +
      "bukan array [1,2,3,…]. Lihat README atau pakai `tsx convert-key.ts <id.json>` untuk konversi."
    );
  }
  let payer: Keypair;
  try {
    payer = Keypair.fromSecretKey(bs58.decode(pkRaw));
  } catch (e: any) {
    throw new Error(`PRIVATE_KEY gagal di-decode sebagai base58: ${e.message}. Cek format.`);
  }
  const conn = new Connection(RPC, "confirmed");

  // Setup Switchboard program
  const wallet = new Wallet(payer);
  const sbProgram = await AnchorUtils.loadProgramFromConnection(
    conn, wallet, ON_DEMAND_MAINNET_PID
  );

  console.log("╔════════════════════════════════════════════╗");
  console.log("║   FLIP HUNTER — Leverage ≥ " + MIN_LEVERAGE_X + "× auto-exec   ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log(`User      : ${payer.publicKey.toBase58()}`);
  console.log(`Wager     : ${WAGER_SOL} SOL`);
  console.log(`Min Lev   : ${MIN_LEVERAGE_X}×`);
  console.log(`Poll      : every ${POLL_INTERVAL_MS}ms`);
  console.log(`Dry run   : ${DRY_RUN}`);
  console.log("─".repeat(46));

  let attempts = 0, fired = 0, lastBestLev = 0;
  while (true) {
    attempts++;
    const pick = await fetchAutoPick(WAGER_SOL, payer.publicKey.toBase58());
    if (!pick || !pick.cheapest_source_mint || !pick.highest_tvl_target_mint) {
      process.stdout.write(`\r[${new Date().toISOString().slice(11,19)}] poll #${attempts} — no pick      `);
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    const lev = Number(pick.leverage_bps) / 10_000;
    const winSol = Number(pick.expected_win_payout_lst) / 1e9 * pick.lst_sol_rate;
    const lossSol = Number(pick.expected_loss_lst) / 1e9 * pick.lst_sol_rate;

    process.stdout.write(
      `\r[${new Date().toISOString().slice(11,19)}] poll #${attempts}: ${pick.cheapest_source_symbol}→${pick.highest_tvl_target_symbol} lev=${lev.toFixed(2)}× (best=${Math.max(lev, lastBestLev).toFixed(2)}×) fired=${fired}      `
    );
    lastBestLev = Math.max(lev, lastBestLev);

    if (lev >= MIN_LEVERAGE_X) {
      console.log("\n");
      console.log("🎯 LEVERAGE HIT!", lev.toFixed(2) + "×");
      console.log(`   ${pick.cheapest_source_symbol} → ${pick.highest_tvl_target_symbol}`);
      console.log(`   Win: +${winSol.toFixed(6)} SOL | Loss: -${lossSol.toFixed(6)} SOL`);
      console.log(`   EV: +${(0.5*winSol - 0.5*lossSol).toFixed(6)} SOL`);

      if (DRY_RUN) {
        console.log("   DRY_RUN=1 → simulate flow tanpa kirim tx beneran");
        try {
          // Build sampai TX 1 saja untuk verifikasi flow tanpa benar2 spend
          const rngKp = Keypair.generate();
          const [randomness, createIx] = await Randomness.create(
            sbProgram, rngKp, SB_QUEUE, payer.publicKey
          );
          const { blockhash } = await conn.getLatestBlockhash("confirmed");
          const msg = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: [
              ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
              createIx,
            ],
          }).compileToV0Message();
          const tx = new VersionedTransaction(msg);
          tx.sign([payer, rngKp]);
          const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
          console.log(`   sim INIT: err=${JSON.stringify(sim.value.err)}, CU=${sim.value.unitsConsumed}`);
          if (sim.value.err) console.error("   logs:\n    " + (sim.value.logs?.join("\n    ") || "(none)"));
        } catch (e: any) {
          console.error("   dry-run sim error:", e.message);
        }
      } else {
        try {
          fired++;
          const sig = await executeFlip(conn, payer, pick, sbProgram);
          console.log(`\n✅ Flip done: https://solscan.io/tx/${sig}`);
          await new Promise(r => setTimeout(r, 8000));
        } catch (e: any) {
          console.error(`\n❌ Flip error: ${e.message}`);
          // Auto-recover: kalau ada randomness yang stuck karena error ini, coba close
          await recoverStuck(conn, payer, sbProgram);

          // Kalau error kehabisan dana, suspend lebih lama (atau exit)
          if (/Saldo SOL kurang|InsufficientFundsForRent|insufficient funds/i.test(e.message)) {
            console.error(`\n⛔ Wallet kehabisan SOL. Top up wallet kamu lalu run lagi.`);
            console.error(`   Pubkey: ${payer.publicKey.toBase58()}`);
            process.exit(1);
          }
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }

    // Auto-recover ringan tiap 12 poll (sekitar 1 menit kalau 5dtk interval)
    if (attempts % 12 === 0 && stuckRandomness.size > 0) {
      await recoverStuck(conn, payer, sbProgram);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

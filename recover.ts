// Recovery randomness account stuck — scan signature history wallet + close
// semua akun yang kamu authority-kan.
// Usage:
//   npm run recover                    → scan history wallet (1000 tx)
//   npm run recover -- <pk1> <pk2> ... → close akun spesifik
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction,
  SystemProgram, AddressLookupTableProgram,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { ON_DEMAND_MAINNET_PID } from "@switchboard-xyz/on-demand";
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

const SB_PROG = new PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT ?? "1000");
const BATCH_SIZE = 12;

async function buildCloseIx(sbProgram: any, randomnessPk: PublicKey) {
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
  return {
    ix: await sbProgram.methods.randomnessClose({}).accounts({
      randomness: randomnessPk, rewardEscrow, authority: data.authority,
      programState, systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID, wrappedSolMint: WSOL,
      lut, lutSigner, addressLookupTableProgram: AddressLookupTableProgram.programId,
    }).instruction(),
    authority: data.authority as PublicKey,
  };
}

async function main() {
  const RPC = process.env.RPC_URL!;
  const pkRaw = process.env.PRIVATE_KEY!;
  if (!RPC || !pkRaw) throw new Error("RPC_URL & PRIVATE_KEY di .env");

  const payer = Keypair.fromSecretKey(bs58.decode(pkRaw));
  const conn = new Connection(RPC, "confirmed");
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const sbProgram = await Program.at(ON_DEMAND_MAINNET_PID, provider);

  const explicitAddrs = process.argv.slice(2).filter(a => a.length >= 32 && a.length <= 50);
  let candidates: Set<string>;

  if (explicitAddrs.length > 0) {
    candidates = new Set(explicitAddrs);
    console.log(`Mode: explicit close, ${candidates.size} addresses`);
  } else {
    console.log("Scanning SB program accounts where authority =", payer.publicKey.toBase58());

    // Direct query: getProgramAccounts dengan memcmp authority @ offset 8.
    // Jauh lebih reliable daripada scan tx history.
    candidates = new Set<string>();
    try {
      const accs = await conn.getProgramAccounts(SB_PROG, {
        commitment: "confirmed",
        encoding: "base64",
        dataSlice: { offset: 0, length: 0 },  // hanya butuh pubkey
        filters: [
          { dataSize: 480 },  // size randomness account
          { memcmp: { offset: 8, bytes: payer.publicKey.toBase58() } },
        ],
      });
      for (const a of accs) candidates.add(a.pubkey.toBase58());
      console.log(`Found ${candidates.size} randomness account(s) owned by you`);
    } catch (e: any) {
      console.error("getProgramAccounts failed (RPC mungkin block):", e.message?.slice(0,100));
      console.log("Fallback: scanning history…");
      // Fallback ke scan history
      const allSigs: string[] = [];
      let before: string | undefined;
      while (allSigs.length < SCAN_LIMIT) {
        const batch = await conn.getSignaturesForAddress(payer.publicKey, {
          limit: Math.min(1000, SCAN_LIMIT - allSigs.length),
          before,
        });
        if (batch.length === 0) break;
        for (const s of batch) if (!s.err) allSigs.push(s.signature);
        before = batch[batch.length - 1].signature;
        if (batch.length < 1000) break;
      }
      console.log(`Found ${allSigs.length} successful tx in history, scanning…`);

      const batches: string[][] = [];
      for (let i = 0; i < allSigs.length; i += BATCH_SIZE) batches.push(allSigs.slice(i, i + BATCH_SIZE));
      let done = 0, errors = 0;
      for (const batch of batches) {
        const txs = await Promise.all(
          batch.map(sig => conn.getTransaction(sig, {
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          }).catch(() => { errors++; return null; }))
        );
        for (const tx of txs) {
          if (!tx?.transaction) continue;
          const msg: any = tx.transaction.message;
          const staticKeys: string[] = msg.accountKeys || [];
          const loaded = tx.meta?.loadedAddresses;
          const allKeys = [
            ...staticKeys,
            ...(loaded?.writable || []),
            ...(loaded?.readonly || []),
          ];
          const outer: any[] = msg.instructions || [];
          const innerAll: any[] = [];
          for (const grp of (tx.meta?.innerInstructions || [])) {
            for (const ix of (grp.instructions || [])) innerAll.push(ix);
          }
          for (const ix of [...outer, ...innerAll]) {
            const progIdx = ix.programIdIndex;
            if (progIdx == null) continue;
            const progPk = allKeys[progIdx];
            if (progPk !== SB_PROG.toBase58()) continue;
            const accIdxs: number[] = ix.accounts || [];
            if (accIdxs.length === 0) continue;
            const firstAcc = allKeys[accIdxs[0]];
            if (firstAcc) candidates.add(firstAcc);
          }
        }
        done += batch.length;
        process.stdout.write(`\r  scanned ${done}/${allSigs.length}, candidates: ${candidates.size}, fetch_err: ${errors}      `);
      }
      console.log();
    }
  }

  console.log(`Checking ${candidates.size} candidate accounts…`);

  const mine: PublicKey[] = [];
  for (const pkStr of candidates) {
    let pk: PublicKey;
    try { pk = new PublicKey(pkStr); } catch { continue; }
    try {
      const info = await conn.getAccountInfo(pk, "confirmed");
      if (!info) continue;
      if (!info.owner.equals(SB_PROG)) continue;
      if (info.data.length !== 480 && info.data.length !== 640) continue;
      const data: any = await sbProgram.account.randomnessAccountData.fetch(pk);
      if (data.authority.toBase58() === payer.publicKey.toBase58()) {
        mine.push(pk);
        console.log(`  ✓ ${pkStr.slice(0,8)}… owned, lutSlot=${data.lutSlot.toString()}`);
      }
    } catch {}
  }

  console.log(`\nWill close ${mine.length} account(s).`);
  if (mine.length === 0) return;

  let totalReclaimed = 0;
  for (const pk of mine) {
    try {
      const { ix: closeIx } = await buildCloseIx(sbProgram, pk);
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(closeIx);
      tx.sign(payer);
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      console.log(`  ✅ closed ${pk.toBase58()} → ${sig.slice(0,20)}…`);
      totalReclaimed += 0.00334;
    } catch (e: any) {
      console.warn(`  ❌ ${pk.toBase58()}: ${e.message?.slice(0,120)}`);
    }
  }
  console.log(`\n💰 Reclaimed ~${totalReclaimed.toFixed(4)} SOL total.`);
}

main().catch(e => { console.error(e); process.exit(1); });

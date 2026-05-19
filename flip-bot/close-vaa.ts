// Close Wormhole EncodedVaa account untuk reclaim rent.
// Akun ini biasanya dibuat saat verify cross-chain message — kalau dibiarkan,
// rent ~0.008 SOL nyangkut. Close manual untuk reclaim.
//
// Usage:
//   npm run close-vaa -- <encodedVaa_pubkey>
//   npm run close-vaa -- 347sBtpHg82r5hEobtWoNo7Rexk48WFBipGUR2fudR3j
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";

const WORMHOLE_CORE = new PublicKey("HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ");

// sha256("global:close_encoded_vaa")[..8]
const CLOSE_ENCODED_VAA_DISC = new Uint8Array([48, 221, 174, 198, 231, 7, 152, 38]);

// EncodedVaa account discriminator (sha256("account:EncodedVaa")[..8])
const ENCODED_VAA_ACC_DISC = "e265a30485a054f5";

function ixCloseEncodedVaa(writeAuthority: PublicKey, encodedVaa: PublicKey) {
  return new TransactionInstruction({
    programId: WORMHOLE_CORE,
    keys: [
      { pubkey: writeAuthority, isSigner: true, isWritable: true },
      { pubkey: encodedVaa, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(CLOSE_ENCODED_VAA_DISC),
  });
}

async function main() {
  const RPC = process.env.RPC_URL!;
  const pkRaw = process.env.PRIVATE_KEY!;
  if (!RPC || !pkRaw) throw new Error("RPC_URL & PRIVATE_KEY di .env");
  const payer = Keypair.fromSecretKey(bs58.decode(pkRaw));
  const conn = new Connection(RPC, "confirmed");

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: npm run close-vaa -- <encodedVaa_pubkey> [...more]");
    console.log("Akan auto-scan & close semua EncodedVaa yang kamu authority-kan.");
    console.log("");
    console.log("Mode auto-scan (tanpa args): scan SB & wormhole untuk akun stuck.");
    // Auto-scan: getProgramAccounts wormhole filtered by writeAuthority offset
    console.log("Scanning Wormhole Core for EncodedVaa accounts owned by",
      payer.publicKey.toBase58() + "…");
    try {
      // EncodedVaa layout: 8 disc + write_authority(32) at offset 8? Let me check by example
      // For our known account, disc at 0-8, then likely write_authority follows
      const accs = await conn.getProgramAccounts(WORMHOLE_CORE, {
        commitment: "confirmed",
        encoding: "base64",
        dataSlice: { offset: 0, length: 0 },
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: bs58.encode(Buffer.from(ENCODED_VAA_ACC_DISC, "hex")),
            },
          },
          {
            memcmp: { offset: 9, bytes: payer.publicKey.toBase58() },  // try offset 9
          },
        ],
      });
      if (accs.length === 0) {
        // Try offset 8
        const accs2 = await conn.getProgramAccounts(WORMHOLE_CORE, {
          commitment: "confirmed",
          encoding: "base64",
          dataSlice: { offset: 0, length: 0 },
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(ENCODED_VAA_ACC_DISC, "hex")) } },
            { memcmp: { offset: 8, bytes: payer.publicKey.toBase58() } },
          ],
        });
        console.log(`Found ${accs2.length} EncodedVaa accounts (offset 8)`);
        args.push(...accs2.map(a => a.pubkey.toBase58()));
      } else {
        console.log(`Found ${accs.length} EncodedVaa accounts (offset 9)`);
        args.push(...accs.map(a => a.pubkey.toBase58()));
      }
    } catch (e: any) {
      console.error("Auto-scan failed:", e.message?.slice(0, 100));
      return;
    }
    if (args.length === 0) return;
  }

  let totalReclaimed = 0;
  for (const pkStr of args) {
    const vaa = new PublicKey(pkStr);
    const info = await conn.getAccountInfo(vaa, "confirmed");
    if (!info) { console.log(`  ${pkStr.slice(0,8)}…: not found`); continue; }
    if (!info.owner.equals(WORMHOLE_CORE)) {
      console.log(`  ${pkStr.slice(0,8)}…: not Wormhole-owned (owner=${info.owner.toBase58().slice(0,8)})`);
      continue;
    }
    const disc = info.data.slice(0, 8).toString("hex");
    if (disc !== ENCODED_VAA_ACC_DISC) {
      console.log(`  ${pkStr.slice(0,8)}…: wrong type (disc=${disc})`);
      continue;
    }
    const rent = info.lamports;
    console.log(`  ${pkStr.slice(0,8)}…: closing (rent ${(rent/1e9).toFixed(6)} SOL)…`);

    try {
      const closeIx = ixCloseEncodedVaa(payer.publicKey, vaa);
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
          closeIx,
        ],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([payer]);

      // Simulate dulu
      const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      if (sim.value.err) {
        console.warn(`    ❌ sim err: ${JSON.stringify(sim.value.err)}`);
        if (sim.value.logs) console.warn("    logs:\n      " + sim.value.logs.slice(-5).join("\n      "));
        continue;
      }

      const sig = await conn.sendTransaction(tx);
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      console.log(`    ✅ closed → ${sig}`);
      totalReclaimed += rent / 1e9;
    } catch (e: any) {
      console.warn(`    ❌ ${e.message?.slice(0,120)}`);
    }
  }
  console.log(`\n💰 Reclaimed ~${totalReclaimed.toFixed(6)} SOL total.`);
}

main().catch(e => { console.error(e); process.exit(1); });

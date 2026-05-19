// Konversi Solana CLI keypair JSON ([1,2,3,…64]) → base58 string.
// Pakai: tsx convert-key.ts <path-to-id.json>
import { readFileSync } from "fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const path = process.argv[2];
if (!path) {
  console.error("Usage: tsx convert-key.ts <path-to-keypair.json>");
  process.exit(1);
}
const arr = JSON.parse(readFileSync(path, "utf8"));
const kp = Keypair.fromSecretKey(Uint8Array.from(arr));
console.log("Public key:", kp.publicKey.toBase58());
console.log("Base58 secret (paste ini ke PRIVATE_KEY .env):");
console.log(bs58.encode(kp.secretKey));

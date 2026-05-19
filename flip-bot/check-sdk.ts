import "dotenv/config";
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { AnchorUtils, ON_DEMAND_MAINNET_PID } from "@switchboard-xyz/on-demand";
import bs58 from "bs58";

const conn = new Connection(process.env.RPC_URL!, "confirmed");
const payer = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
const wallet = new Wallet(payer);
const sbProgram = await AnchorUtils.loadProgramFromConnection(conn, wallet, ON_DEMAND_MAINNET_PID);

const idl = (sbProgram as any).idl;
const closeIx = idl.instructions.find((i: any) => i.name === "randomnessClose");
console.log("randomnessClose ix:");
console.log(JSON.stringify(closeIx, null, 2));

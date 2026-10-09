const { Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;
const config = require('../config');
const { rpc, getConnection } = require('./rpc');

let wallet;

function loadWallet() {
  if (wallet) return wallet;
  const key = config.WALLET_PRIVATE_KEY;
  if (!key) {
    if (config.DRY_RUN) {
      wallet = Keypair.generate();
      console.warn('[wallet] DRY_RUN with an ephemeral keypair (paper trading, no real funds)');
      return wallet;
    }
    throw new Error('WALLET_PRIVATE_KEY required when DRY_RUN=false');
  }
  const raw = key.trim();
  const secret = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  wallet = Keypair.fromSecretKey(secret);
  return wallet;
}

function address() {
  return loadWallet().publicKey.toBase58();
}

/** Exact lamports as BigInt */
async function getSolLamports() {
  const w = loadWallet();
  return BigInt(await rpc((c) => c.getBalance(w.publicKey, 'confirmed')));
}

async function getSolBalance() {
  return Number(await getSolLamports()) / LAMPORTS_PER_SOL;
}

/** Exact token balance of `mint` across all of the wallet's token accounts. */
async function getTokenBalance(mint) {
  const w = loadWallet();
  const res = await rpc((c) =>
    c.getParsedTokenAccountsByOwner(w.publicKey, { mint: new PublicKey(mint) }, 'confirmed')
  );
  let raw = 0n;
  let decimals = null;
  for (const a of res.value) {
    const ta = a.account.data.parsed.info.tokenAmount;
    raw += BigInt(ta.amount);
    decimals = ta.decimals;
  }
  const ui = decimals == null ? 0 : Number(raw) / 10 ** decimals;
  return { raw, decimals, ui };
}

/** Mint/freeze authority. null means revoked (good). */
async function getMintInfo(mint) {
  const info = await rpc((c) => c.getParsedAccountInfo(new PublicKey(mint), 'confirmed'));
  const parsed = info && info.value && info.value.data && info.value.data.parsed;
  if (!parsed || parsed.type !== 'mint') throw new Error('not a token mint');
  return {
    mintAuthority: parsed.info.mintAuthority || null,
    freezeAuthority: parsed.info.freezeAuthority || null,
    decimals: parsed.info.decimals,
  };
}

module.exports = {
  getConnection,
  loadWallet,
  address,
  getSolLamports,
  getSolBalance,
  getTokenBalance,
  getMintInfo,
  LAMPORTS_PER_SOL,
};

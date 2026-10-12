# PenguMint setup

## 1 Website deployment

Unzip the package. Keep `app`, `components`, `contracts`, `lib`, `public`, `scripts`, `tests` and root configuration files together. Install with `npm ci` using Node 24. Run `npm run dev` locally, or deploy the repository as a Next.js project on Vercel.

You can reuse https://github.com/PAFRehman/jetjuth. Replace its old application files with this complete project's contents so obsolete apology/admin API routes are not retained. Keep your actual `.git` directory. Remove obsolete Supabase variables from this new app's Vercel settings when no longer needed; this code does not modify your old database or its data.

Inside the existing local repository:

```bash
git remote -v
git status
git add .
git commit -m "Build PenguMint student blockchain studio"
git push origin HEAD
```

For a new folder that is not a Git repository, clone the existing repository first, then copy this project's contents into that clone. Avoid force-pushing an unrelated history.

## 2 Wallet and test ETH

Open **Your wallet**. Create an encrypted wallet with a password of at least 10 characters, or connect an EVM browser wallet. Download the encrypted backup. Open **Get free test ETH**, choose a faucet for **Base Sepolia**, and paste the wallet address. Refresh the balance after the faucet transfer confirms.

Browser wallet publishing will ask to switch to chain **84532**. Built-in signing and broadcasting use that chain only. Use https://sepolia.basescan.org to inspect real public transactions.

## 3 Shared classroom wall

Click **Set up your classroom wall** or the **Base Sepolia** network label.

- To deploy: connect/unlock a funded testnet wallet, click **Estimate deployment gas**, review, then **Confirm deployment**. Wait for a successful receipt.
- To reuse a wall: paste its contract address and click **Open this wall**. The server checks network and exact runtime bytecode against the bundled contract.
- Share the full `?contract=0x...` URL with classmates. Every viewer sees the same selected wall.
- For one default public wall, add `NEXT_PUBLIC_MINT_CONTRACT=0x...` in Vercel and **redeploy**. A wall remembered in one browser is not a global deployment setting.

The included compiled artifact is ready for the setup wizard. If you change the Solidity source, compile again with the pinned compiler and deploy a new wall; exact-bytecode validation will reject a different contract.

## 4 Optional IPFS upload

Notes, compact images, creative signatures and private file proofs work without a storage account. Existing public `ipfs://` media links also work without an upload account.

For full media uploads, create an IPFS pinning JWT in Pinata and add server variables in Vercel:

```text
PINATA_JWT=<your server-only Pinata JWT>
UPLOAD_AUTH_SECRET=<a long random secret>
```

Redeploy. The browser hashes the file and obtains a signed, expiring permission before the server pins it. Your JWT never appears in the client. Supported uploads are PNG, JPG, WebP, GIF, MP4, WebM, MP3, OGG, WAV and PDF, up to 3 MB. Already-pinned larger media can use its existing IPFS URI. Keep files pinned for continued media availability; blockchain metadata alone does not maintain an IPFS pin.

## 5 Optional QR wallet connection

Create a project ID in the Reown dashboard, add your Vercel and custom domains to its allowlist, set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, and redeploy. This enables the **Connect a mobile wallet** QR option. Installed/injected browser wallets and in-site wallets need no Reown setting.

## 6 RPC and database

Base Sepolia's public RPC is the default. For a class, optionally set a dedicated server-only `BASE_SEPOLIA_RPC_URL` for chain 84532. The server refuses another chain.

**No conventional database is required.** Public creation records and learning counters live in the smart contract, large media in IPFS, and encrypted wallets/drafts locally. Gallery reads are performed by Next.js server routes. Four-second polling is visible-page-only. For a larger public service, add shared upload-rate limiting and event indexing as a later extension.

## 7 Custom domain and sound

Add `0to1.world` in Vercel's Domains settings and apply the DNS records it gives you. The app attempts to start its original music on open and resumes it on the first permitted tap/click/key. Browser autoplay policies can require that interaction; a website cannot override them. The speaker button lets students mute it. Scenery and actors pause in hidden tabs and respect reduced-motion preferences.

## 8 First classroom demonstration

Deploy one wall, open its shared URL in two browsers, connect different wallets, and get test ETH. Mint a note in browser A and watch it appear in B after confirmation. Verify its creator signature in B, then review and confirm a peer acknowledgement. Mint a file proof and compare the original file locally. Publish a new project version linked to your own earlier token ID. Open **Learn** to view the contract-backed milestones.

# PenguMint architecture

## Storage and authority

| Data | Location | Change rules |
| --- | --- | --- |
| Encrypted wallet | Browser localStorage / downloaded JSON | User unlocks with password; server never receives key |
| Decrypted signing key | Browser memory | Cleared on lock, disconnect, unmount or idle timeout |
| Drafts | Browser localStorage, per creator address | Create, read, update and delete locally |
| Confirmed creation | PenguMint contract on Base Sepolia | Immutable content; ERC-721 ownership can transfer |
| Compact image or signature | Data URI in contract | Signed before mint; exact encoded preview is committed |
| Larger media | IPFS | Content-addressed; continued retrieval depends on pins/gateways |
| Private file proof | SHA-256 in contract | Original file stays local; anyone with the exact file can compare |
| Revision link | Contract parent token ID | Only original creator may link their own record |
| Witness and passport | Contract mappings/counters | Another wallet acknowledges once per record |
| Gallery cache | Client memory | Refreshed from confirmed activity while page is visible |

## Publish flow

1. Student creates/connects a wallet and chooses a classroom contract.
2. Student edits a draft; media is encoded inline or uploaded using a signed expiring permission.
3. Browser constructs an ABI-encoded commitment and an EIP-191 message bound to chain 84532, contract, creator, content, title and kind.
4. Wallet signs a free creator proof. RPC simulates the mint and estimates execution gas.
5. Student accepts that publishing is permanent/public and explicitly confirms the transaction.
6. Contract verifies the signature, content duplicate and parent ownership; stores a creation, mints ERC-721 and increments the passport/activity counters.
7. Receipt confirmation triggers the visible celebration and refresh. Other visible clients poll activity every four seconds and read changes.

## Onchain interfaces

`mint(MintInput, proof)`, `getCreation(id)`, `getPage(cursor, limit)`, `tokenURI(id)`, `witness(id)`, `witnessed(id, wallet)`, `passports(wallet)`, `latestId()` and `activityNonce()`.

`MintInput` holds title, note, media URI/type, file hash, kind and previous ID. Kinds are media (0), note (1), creative signature (2), and private file proof (3). Pages contain at most 12 records; the app requests 8. The contract uses OpenZeppelin ERC721, ReentrancyGuard, SignatureChecker and JSON escaping. It accepts EOAs and deployed ERC-1271 signing wallets.

## Trust boundaries

Contract state is authoritative. The server verifies the RPC chain and included runtime bytecode before treating an address as a PenguMint wall. The app restricts broadcasting to Base Sepolia. The RPC proxy permits only public read/estimate/broadcast methods; wallet-management and node-admin methods are blocked.

Wallet keys use cryptographically secure generation, PBKDF2 SHA-256 (310,000 rounds) and AES-GCM encryption with independent random salt and nonce. This protects stored backups, not an unlocked browser compromised by malicious code. A lost password cannot be recovered by the site.

Raster data URIs and strict IPFS references are the only media paths rendered. SVG/HTML/JavaScript content is not embedded. Notes and titles are plain React text. Uploads require same-origin requests, a wallet signature, an expiring HMAC challenge, a matching SHA-256 checksum, size checks and file magic-byte validation. Pinata JWT remains server-only.

Public content is permanent and cannot be removed by a hidden admin. Wallet proofs establish approval by an address, not verified personal identity, legal copyright or an instructor grade. Peer witnesses are similarly address acknowledgements. No marketplace, mainnet transfer or credential issuer is included.

## Rendering and accessibility

The exact original moving coastline is pre-rendered into seamless landscape/portrait native videos. The browser uses a native decoder instead of recomputing ocean FFTs, volumetric sky and vegetation on each frame. One original articulated penguin, envelopes/hearts and the detailed celebration jet remain live 3D with instancing, shared geometry, an offscreen worker, a GPU fence and a 30 fps submission cap. Only one penguin rig and contact shadow are instantiated. Flowers are removed. A single vector guide remains available if WebGL cannot start.

The original score uses native buffered audio loops with smooth scene changes. Autoplay is attempted; the first browser-permitted interaction resumes blocked audio. Hidden tabs release active animation work. Motion preferences, manual mute/pause, native accessible dialogs, labels and visible errors are included. Pip is a deterministic contextual guide driven by current app state, not an external LLM.

## Capacity and limits

Direct images are encoded to WebP and downscaled until their data URI fits below the 16 KB contract limit. Notes have a 4096-byte contract maximum; the UI limits text to 2000 characters and also checks UTF-8 bytes. Titles have a 96-byte contract maximum. Uploads are limited to 3 MB to fit serverless request limits. Private file proofs accept local files up to 50 MB. Existing IPFS references support larger media without sending the file through Vercel.

Execution gas is estimated and padded; Base's L1 data fee is disclosed separately. The estimate is not an exact final transaction fee. The public RPC can be rate-limited, and IPFS availability depends on pinning/gateway service. Upload throttling currently uses process memory and is not shared across serverless instances. A larger deployment should add persistent rate limiting, event indexing and paginated search over the entire chain history.

The package is not a deployed public contract or a claimed security audit. Local EVM and browser validation are documented separately. Optional Pinata and WalletConnect integrations require the operator's own settings.

## Primary references

- Base network settings: https://docs.base.org/get-started/connect-to-base
- Test ETH faucets: https://docs.base.org/base-chain/tools/network-faucets
- OpenZeppelin ERC-721: https://docs.openzeppelin.com/contracts/5.x/erc721
- viem wallet clients: https://viem.sh/docs/clients/wallet
- Wallet discovery: https://eips.ethereum.org/EIPS/eip-6963
- Pinata pinFileToIPFS: https://docs.pinata.cloud/api-reference/endpoint/ipfs/pin-file-to-ipfs
- Reown Ethereum provider: https://docs.reown.com/advanced/providers/ethereum

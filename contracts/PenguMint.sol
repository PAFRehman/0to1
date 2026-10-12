// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice An open, immutable student creation wall. No mint fee or administrator.
contract PenguMint is ERC721, ReentrancyGuard {
    struct MintInput {
        string title;
        string note;
        string mediaURI;
        string mediaType;
        bytes32 fileHash;
        uint8 kind; // 0 media, 1 note, 2 drawn signature, 3 private file proof
        uint256 previousId;
    }
    struct Creation {
        uint256 tokenId;
        address creator;
        uint64 mintedAt;
        uint8 kind;
        string title;
        string note;
        string mediaURI;
        string mediaType;
        bytes32 fileHash;
        bytes32 contentHash;
        bytes proof;
        uint256 previousId;
        uint32 witnessCount;
    }
    uint256 public latestId;
    uint256 public activityNonce;
    struct Passport { uint32 media; uint32 notes; uint32 signatures; uint32 proofs; uint32 witnessed; uint64 firstSeen; }
    mapping(address => Passport) public passports;
    mapping(uint256 => mapping(address => bool)) public witnessed;
    mapping(uint256 => Creation) private creations;
    mapping(address => mapping(bytes32 => bool)) public alreadyMinted;
    event CreationMinted(uint256 indexed tokenId, address indexed creator, uint8 kind, bytes32 contentHash);
    event WorkWitnessed(uint256 indexed tokenId, address indexed witness, uint64 timestamp);

    constructor() ERC721("PenguMint Student Creations", "PENGU") {}
    function studioVersion() external pure returns (string memory) { return "pengumint-1"; }

    function contentHashOf(MintInput calldata input) public pure returns (bytes32) {
        return keccak256(abi.encode(input.note, input.mediaURI, input.mediaType, input.fileHash, input.previousId));
    }
    function proofMessage(address creator, bytes32 contentHash, string memory title, uint8 kind) public view returns (string memory) {
        return string(abi.encodePacked("PenguMint creation\nChain: ", Strings.toString(block.chainid), "\nContract: ", Strings.toHexString(uint160(address(this)), 20), "\nCreator: ", Strings.toHexString(uint160(creator), 20), "\nContent: ", Strings.toHexString(uint256(contentHash), 32), "\nTitle: ", title, "\nKind: ", Strings.toString(kind)));
    }
    function mint(MintInput calldata input, bytes calldata proof) external nonReentrant returns (uint256 id) {
        require(bytes(input.title).length > 0 && bytes(input.title).length <= 96, "Title must be 1-96 bytes");
        require(bytes(input.note).length <= 4096, "Note exceeds 4096 bytes");
        require(bytes(input.mediaURI).length <= 16384, "Media exceeds inline limit");
        require(bytes(input.mediaType).length > 0 && bytes(input.mediaType).length <= 80, "Invalid media type");
        require(input.kind <= 3, "Unknown creation type");
        require(input.kind == 1 ? bytes(input.note).length > 0 : input.kind == 3 ? input.fileHash != bytes32(0) : bytes(input.mediaURI).length > 0, "Add your creation");
        require(input.previousId == 0 || creations[input.previousId].creator == msg.sender, "Only link your own prior work");
        bytes32 hash = contentHashOf(input);
        require(!alreadyMinted[msg.sender][hash], "You already minted this creation");
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(bytes(proofMessage(msg.sender, hash, input.title, input.kind)));
        require(SignatureChecker.isValidSignatureNow(msg.sender, digest, proof), "Creator proof is invalid");
        alreadyMinted[msg.sender][hash] = true;
        id = ++latestId;
        creations[id] = Creation(id, msg.sender, uint64(block.timestamp), input.kind, input.title, input.note, input.mediaURI, input.mediaType, input.fileHash, hash, proof, input.previousId, 0);
        Passport storage p = passports[msg.sender];
        if (p.firstSeen == 0) p.firstSeen = uint64(block.timestamp);
        if (input.kind == 0) ++p.media; else if (input.kind == 1) ++p.notes; else if (input.kind == 2) ++p.signatures; else ++p.proofs;
        ++activityNonce;
        _safeMint(msg.sender, id);
        emit CreationMinted(id, msg.sender, input.kind, hash);
    }
    /// @notice A peer wallet can acknowledge a record once. This is not an instructor grade.
    function witness(uint256 id) external {
        require(_ownerOf(id) != address(0), "Creation does not exist");
        require(creations[id].creator != msg.sender, "Ask another wallet to witness your work");
        require(!witnessed[id][msg.sender], "You already witnessed this work");
        witnessed[id][msg.sender] = true;
        ++creations[id].witnessCount;
        Passport storage p = passports[msg.sender];
        if (p.firstSeen == 0) p.firstSeen = uint64(block.timestamp);
        ++p.witnessed;
        ++activityNonce;
        emit WorkWitnessed(id, msg.sender, uint64(block.timestamp));
    }
    function getCreation(uint256 id) public view returns (Creation memory) {
        require(_ownerOf(id) != address(0), "Creation does not exist");
        return creations[id];
    }
    /// @notice Newest first; pass zero for latest, then last id minus one.
    function getPage(uint256 cursor, uint256 limit) external view returns (Creation[] memory result) {
        require(limit > 0 && limit <= 12, "Page size is 1-12");
        uint256 start = cursor == 0 || cursor > latestId ? latestId : cursor;
        uint256 count = start < limit ? start : limit;
        result = new Creation[](count);
        for (uint256 i; i < count; ++i) result[i] = creations[start-i];
    }
    function tokenURI(uint256 id) public view override returns (string memory) {
        Creation memory c = getCreation(id);
        string memory media = bytes(c.mediaURI).length == 0 ? "" : string(abi.encodePacked(',"image":"', Strings.escapeJSON(c.mediaURI), '"', _isMoving(c.mediaType) ? string(abi.encodePacked(',"animation_url":"', Strings.escapeJSON(c.mediaURI), '"')) : ""));
        string memory json = string(abi.encodePacked('{"name":"', Strings.escapeJSON(c.title), '","description":"', Strings.escapeJSON(c.note), '"', media, ',"creator":"', Strings.toHexString(uint160(c.creator),20), '","content_hash":"', Strings.toHexString(uint256(c.contentHash),32), '","file_hash":"', Strings.toHexString(uint256(c.fileHash),32), '","previous_version":', Strings.toString(c.previousId), ',"attributes":[{"trait_type":"Creation type","value":"', c.kind == 1 ? "Note" : c.kind == 2 ? "Signature" : c.kind == 3 ? "File proof" : "Media", '"},{"trait_type":"Created at","value":', Strings.toString(c.mintedAt), '}]}'));
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
    function _isMoving(string memory mime) private pure returns (bool) {
        bytes memory b = bytes(mime);
        return b.length >= 6 && (b[0] == "v" || b[0] == "a");
    }
}

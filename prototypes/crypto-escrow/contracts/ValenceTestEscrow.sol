// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {TestNetworkOnly} from "./TestNetworkOnly.sol";

/// @notice TEST MONEY ONLY. Unaudited, non-upgradeable, per-deal escrow prototype.
/// @dev No admin sweep, arbitrary token support, pooled user balances, or auto-conversion.
contract ValenceTestEscrow is ReentrancyGuard, EIP712, TestNetworkOnly {
    using SafeERC20 for IERC20;

    enum State { Missing, Funded, Delivered, Disputed, Released, Refunded }
    struct Deal {
        address buyer;
        address seller;
        address asset; // zero = test ETH; otherwise the one configured test token
        uint256 principal;
        uint256 fee;
        uint256 deadline;
        uint256 reviewEnds;
        bytes32 termsHash;
        State state;
    }

    uint256 public constant FEE_BPS = 100;
    uint256 public constant REVIEW_SECONDS = 72 hours;
    bytes32 public constant RESOLUTION_TYPEHASH = keccak256("Resolution(bytes32 dealId,bool paySeller,uint256 validUntil)");
    address public immutable treasury;
    address public immutable arbitrator;
    address public immutable testToken;
    uint256 public nonce;
    mapping(bytes32 => Deal) public deals;
    // Claims belong to a single finalized deal; they cannot fund another deal.
    mapping(bytes32 => mapping(address => uint256)) public claimable;

    error InvalidTerms();
    error WrongValue();
    error UnknownDeal();
    error WrongState();
    error Unauthorized();
    error TooEarly();
    error TooLate();
    error InvalidAsset();
    error UnsupportedTokenBehavior();
    error NoClaim();
    error TransferFailed();
    error InvalidAward();
    error ExpiredAward();

    event Funded(bytes32 indexed id, address indexed buyer, address indexed seller,
        address asset, uint256 principal, uint256 fee, uint256 deadline, bytes32 termsHash);
    event Delivered(bytes32 indexed id, uint256 reviewEnds);
    event Disputed(bytes32 indexed id, address indexed openedBy);
    event Finalized(bytes32 indexed id, State state);
    event Claimed(bytes32 indexed id, address indexed beneficiary, address indexed to, uint256 amount);

    constructor(address treasury_, address arbitrator_, address testToken_) EIP712("ValenceTestEscrow", "1") {
        if (treasury_ == address(0) || arbitrator_ == address(0)
            || treasury_ == address(this) || arbitrator_ == address(this)
            || testToken_.code.length == 0) revert InvalidTerms();
        treasury = treasury_;
        arbitrator = arbitrator_;
        testToken = testToken_;
    }

    function feeFor(uint256 principal) public pure returns (uint256) {
        // Exact 1% in atomic units. Reject sub-atomic percentage rounding.
        if (principal == 0 || principal % 100 != 0) revert InvalidTerms();
        return principal / 100;
    }

    function fund(address seller, address asset, uint256 principal, uint256 deadline,
        bytes32 termsHash) external payable nonReentrant returns (bytes32 id) {
        if (seller == address(0) || seller == address(this) || seller == msg.sender
            || seller == arbitrator || msg.sender == arbitrator
            || deadline < block.timestamp + 1 hours || deadline > block.timestamp + 30 days
            || termsHash == bytes32(0)) revert InvalidTerms();
        if (asset != address(0) && asset != testToken) revert InvalidAsset();
        uint256 fee = feeFor(principal);
        uint256 total = principal + fee;
        // Bind every funded term too: a reorg cannot reuse the same ID for different terms.
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, seller,
            asset, principal, deadline, termsHash, nonce++));
        deals[id] = Deal(msg.sender, seller, asset, principal, fee, deadline, 0, termsHash, State.Funded);
        if (asset == address(0)) {
            if (msg.value != total) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20 token = IERC20(asset);
            uint256 beforeBalance = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), total);
            if (token.balanceOf(address(this)) - beforeBalance != total) revert UnsupportedTokenBehavior();
        }
        emit Funded(id, msg.sender, seller, asset, principal, fee, deadline, termsHash);
    }

    function markDelivered(bytes32 id) external {
        Deal storage d = _deal(id);
        if (msg.sender != d.seller) revert Unauthorized();
        if (d.state != State.Funded) revert WrongState();
        if (block.timestamp >= d.deadline) revert TooLate();
        d.reviewEnds = block.timestamp + REVIEW_SECONDS;
        d.state = State.Delivered;
        emit Delivered(id, d.reviewEnds);
    }

    function release(bytes32 id) external {
        Deal storage d = _deal(id);
        if (msg.sender != d.buyer) revert Unauthorized();
        if (d.state != State.Funded && d.state != State.Delivered) revert WrongState();
        _finalize(id, d, true);
    }

    function refund(bytes32 id) external {
        Deal storage d = _deal(id);
        if (d.state != State.Funded && d.state != State.Delivered) revert WrongState();
        if (msg.sender != d.seller) {
            if (msg.sender != d.buyer) revert Unauthorized();
            // A timely delivery gets its full review period; the work deadline cannot override it.
            if (d.state != State.Funded) revert WrongState();
            if (block.timestamp < d.deadline) revert TooEarly();
        }
        _finalize(id, d, false);
    }

    function dispute(bytes32 id) external {
        Deal storage d = _deal(id);
        if (msg.sender != d.buyer && msg.sender != d.seller) revert Unauthorized();
        if (d.state != State.Funded && d.state != State.Delivered) revert WrongState();
        if (d.state == State.Delivered && block.timestamp >= d.reviewEnds) revert TooLate();
        d.state = State.Disputed;
        emit Disputed(id, msg.sender);
    }

    function resolve(bytes32 id, bool paySeller) external {
        if (msg.sender != arbitrator) revert Unauthorized();
        Deal storage d = _deal(id);
        if (d.state != State.Disputed) revert WrongState();
        _finalize(id, d, paySeller);
    }

    /// @notice A customer pays gas to submit an off-chain decision signed by Valence.
    /// @dev The signature binds the deal, decision, expiry, chain and contract. State prevents replay.
    function resolveWithSignature(bytes32 id, bool paySeller, uint256 validUntil, bytes calldata signature) external {
        Deal storage d = _deal(id);
        if (d.state != State.Disputed) revert WrongState();
        if (block.timestamp > validUntil) revert ExpiredAward();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RESOLUTION_TYPEHASH, id, paySeller, validUntil)));
        if (!SignatureChecker.isValidSignatureNow(arbitrator, digest, signature)) revert InvalidAward();
        _finalize(id, d, paySeller);
    }

    function finalizeAfterReview(bytes32 id) external {
        Deal storage d = _deal(id);
        if (d.state != State.Delivered) revert WrongState();
        if (block.timestamp < d.reviewEnds) revert TooEarly();
        _finalize(id, d, true);
    }

    function claim(bytes32 id, address payable to) external nonReentrant {
        _claim(id, msg.sender, to);
    }

    /// @notice Anyone can pay claim gas, but funds always go to the named beneficiary.
    /// @dev Lets customers claim the Valence fee without Valence paying network fees.
    function claimFor(bytes32 id, address beneficiary) external nonReentrant {
        _claim(id, beneficiary, payable(beneficiary));
    }

    function _claim(bytes32 id, address beneficiary, address payable to) private {
        Deal storage d = _deal(id);
        if (to == address(0) || to == address(this)) revert InvalidTerms();
        uint256 amount = claimable[id][beneficiary];
        if (amount == 0) revert NoClaim();
        claimable[id][beneficiary] = 0;
        if (d.asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(d.asset).safeTransfer(to, amount);
        }
        emit Claimed(id, beneficiary, to, amount);
    }

    function _deal(bytes32 id) private view returns (Deal storage d) {
        d = deals[id];
        if (d.state == State.Missing) revert UnknownDeal();
    }

    function _finalize(bytes32 id, Deal storage d, bool paySeller) private {
        // No external transfers here. One recipient cannot block another's claim.
        d.state = paySeller ? State.Released : State.Refunded;
        if (paySeller) {
            claimable[id][d.seller] += d.principal;
            claimable[id][treasury] += d.fee;
        } else {
            claimable[id][d.buyer] += d.principal + d.fee;
        }
        emit Finalized(id, d.state);
    }
}

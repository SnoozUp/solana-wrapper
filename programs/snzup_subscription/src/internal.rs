// internal.rs

use anchor_lang::prelude::*;


// Bonus math 
pub fn calculate_competition_bonus(
    total_pool: u64,
    commission_rate: u8,
    winners_count: usize,
) -> Result<(u64, u64, u64)> {
    let commission_amount = (total_pool * commission_rate as u64) / 100;
    let bonus_pool = total_pool - commission_amount;
    let winner_amount = if winners_count > 0 { bonus_pool / winners_count as u64 } else { 0 };
    Ok((commission_amount, bonus_pool, winner_amount))
}

// Subscription guardrails
pub fn validate_subscription(state: &State, subscriber: &Pubkey) -> Result<()> {
    require!(state.status == 0, ErrorCode::ChallengeInProgressOrExpired); // Only Pending
    require!(state.subscribers.len() < State::MAX_SUBSCRIBERS, ErrorCode::MaxSubscribersReached);
    require!(!state.subscribers.contains(subscriber), ErrorCode::AlreadySubscribed);
    Ok(())
}

// Small free-function wrappers so lib.rs can call these 
pub fn validate_primary_owner(signer: &Pubkey, expected_owner: &Pubkey) -> Result<()> {
    ErrorCode::validate_primary_owner(signer, expected_owner)
}
pub fn validate_allowed_user(signer: &Pubkey, state: &State) -> Result<()> {
    ErrorCode::validate_allowed_user(signer, state)
}



#[account]
pub struct State {
    pub version: u8,               // 1
    pub bump: u8,                  // 1
    pub challenge_id: u64,         // 8
    pub fee: u64,                  // 8  (lamports)
    pub commission: u8,            // 1  (0..=100)
    pub status: u8,                // 1  (0=PENDING,1=IN_PROGRESS,2=CLOSED,3=CANCELED)
    pub owner: Pubkey,             // 32
    pub treasury: Pubkey,          // 32 (pinned payout target)
    pub paid: bool,                // 1  (once true, distribution cannot run again)
    pub op_counter: u64,           // 8  (operation counter for parity with Solidity)
    pub owners: Vec<Pubkey>,       // 4 + N*32
    pub subscribers: Vec<Pubkey>,  // 4 + M*32
    pub winners_list: Vec<Pubkey>, // 4 + W*32
}

impl State {
    pub const CURRENT_VERSION: u8 = 1;

    pub const MAX_SUBSCRIBERS: usize = 100;
    pub const MAX_WINNERS: usize = 10;
    pub const MAX_OWNERS: usize = 5;

    pub const MAX_SIZE: usize =
        8 + // discriminator
        1 + // version
        1 + // bump
        8 + // challenge_id
        8 + // fee
        1 + // commission
        1 + // status
        32 + // owner
        32 + // treasury
        1 + // paid
        8 + // op_counter
        (4 + Self::MAX_OWNERS * 32) +
        (4 + Self::MAX_SUBSCRIBERS * 32) +
        (4 + Self::MAX_WINNERS * 32);

    pub fn needs_migration(&self) -> bool {
        self.version != Self::CURRENT_VERSION
    }
}

//Errors

#[error_code]
pub enum ErrorCode {
    // 6000–6099: Access control
    #[msg("Only contract owner can call this function")]
    OnlyOwner = 6000,
    #[msg("Only contract owner an allowed users can call this function")]
    OnlyAllowedUsers,

    // 6100–6199: Subscription validation
    #[msg("Challenge is in progress or expired")]
    ChallengeInProgressOrExpired = 6100,
    #[msg("Insufficient balance")]
    InsufficientBalance,

    // (SPL error for future, not used in SOL mode)
    #[msg("Insufficient allowance")]
    InsufficientAllowance,
    #[msg("erc20 token transfer failed")]
    TokenTransferFailed,

    // 6200–6299: Bonus / treasury
    #[msg("Invalid snoozupWallet address")]
    InvalidSnoozupWalletAddress = 6200,
    #[msg("Invalid winner address")]
    InvalidWinnerAddress,
    #[msg("Approval winner failed")]
    ApprovalWinnerFailed,
    #[msg("Transfer to winner failed")]
    TransferToWinnerFailed,
    #[msg("No balance left for snoozup")]
    NoBalanceLeftForSnoozup,
    #[msg("Approval snoozup wallet failed")]
    ApprovalSnoozupWalletFailed,
    #[msg("Transfer to snoozup wallet failed")]
    TransferToSnoozupWalletFailed,

    // 6300–6399: Refund
    #[msg("Insufficient contract balance")]
    InsufficientContractBalance = 6300,
    #[msg("Invalid subscriber address")]
    InvalidSubscriberAddress,
    #[msg("Transfer to subscriber failed")]
    TransferToSubscriberFailed,

    // 6400–6499: Misc
    #[msg("Invalid commission rate")]
    InvalidCommissionRate = 6400,
    #[msg("Invalid nonce - must be greater than current nonce")]
    InvalidNonce,
    #[msg("Insufficient funds in vault")]
    InsufficientFunds,
    #[msg("Too many winners")]
    TooManyWinners,
    #[msg("Too many owners")]
    TooManyOwners,
    #[msg("Already migrated")]
    AlreadyMigrated,
    #[msg("Invalid input")]
    InvalidInput,
    #[msg("Missing winner account")]
    MissingWinnerAccount,         // check remaining_accounts length
    #[msg("Missing subscriber account")]
    MissingSubscriberAccount,    
    #[msg("No pending rotation")]
    NoPendingRotation,
    #[msg("Not pending owner")]
    NotPendingOwner,
    #[msg("Rotation too early")]
    RotationTooEarly,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid status")]
    InvalidStatus,
    #[msg("Maximum subscribers reached")]
    MaxSubscribersReached,
    #[msg("Already subscribed")]
    AlreadySubscribed,
    #[msg("Lamport arithmetic overflow/underflow")]
    LamportMathError,
}

impl ErrorCode {
    pub fn validate_primary_owner(signer: &Pubkey, expected_owner: &Pubkey) -> Result<()> {
        require!(*signer == *expected_owner, ErrorCode::OnlyOwner);
        Ok(())
    }
    pub fn validate_allowed_user(signer: &Pubkey, state: &State) -> Result<()> {
        let is_owner = *signer == state.owner;
        let is_multi_owner = state.owners.contains(signer);
        require!(is_owner || is_multi_owner, ErrorCode::OnlyAllowedUsers);
        Ok(())
    }
}

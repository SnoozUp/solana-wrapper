use anchor_lang::prelude::*;
use crate::internal::State;

// Account setup for creating a new challenge
#[derive(Accounts)]
#[instruction(challenge_id: u64)]
pub struct Initialize<'info> {
    // Create new state account with specific size and seeds
    #[account(
        init,                    // Create new account
        payer = owner,          // Owner pays for account creation
        space = State::MAX_SIZE, // Set account size
        seeds = [b"state", owner.key().as_ref(), &challenge_id.to_le_bytes()], // Unique address
        bump                     // Add randomness for security
    )]
    pub state: Account<'info, State>,

    // The person creating the challenge 
    #[account(mut)]
    pub owner: Signer<'info>,

    // Solana system program (needed for account creation)
    pub system_program: Program<'info, System>,
}

// Account setup for someone joining a challenge
#[derive(Accounts)]
pub struct Subscribe<'info> {
    // Find existing challenge state account
    #[account(
        mut,                    // We will modify this account
        seeds = [b"state", state.owner.as_ref(), &state.challenge_id.to_le_bytes()], // Find by owner + challenge ID
        bump = state.bump       // Use stored bump for security
    )]
    pub state: Account<'info, State>,

    // The person joining the challenge 
    #[account(mut)]
    pub subscriber: Signer<'info>,

    // Solana system program (needed for SOL transfers)
    pub system_program: Program<'info, System>,
}

// Account setup for sending prizes to winners
#[derive(Accounts)]
pub struct SendBonus<'info> {
    // Find challenge state account
    #[account(
        mut,                    // We will modify this account
        seeds = [b"state", state.owner.as_ref(), &state.challenge_id.to_le_bytes()], // Find by owner + challenge ID
        bump = state.bump       // Use stored bump for security
    )]
    pub state: Account<'info, State>,

    // Challenge owner (must sign to distribute prizes)
    pub owner: Signer<'info>,

    // Company wallet that receives commission
    #[account(mut)]
    pub treasury_wallet: SystemAccount<'info>,

    // Solana system program (needed for SOL transfers)
    pub system_program: Program<'info, System>,
}

// Account setup for giving money back to subscribers
#[derive(Accounts)]
pub struct RefundBatch<'info> {
    // Find challenge state account
    #[account(
        mut,                    // We will modify this account
        seeds = [b"state", state.owner.as_ref(), &state.challenge_id.to_le_bytes()], // Find by owner + challenge ID
        bump = state.bump       // Use stored bump for security
    )]
    pub state: Account<'info, State>,

    // Only the challenge owner can give refunds
    #[account(constraint = owner.key() == state.owner @ crate::internal::ErrorCode::OnlyOwner)]
    pub owner: Signer<'info>,

    // Solana system program (needed for SOL transfers)
    pub system_program: Program<'info, System>,
}


// Account setup for functions only the owner can use
#[derive(Accounts)]
pub struct OnlyOwner<'info> {
    // Find challenge state account
    #[account(
        mut,                    // We will modify this account
        seeds = [b"state", state.owner.as_ref(), &state.challenge_id.to_le_bytes()], // Find by owner + challenge ID
        bump = state.bump,      // Use stored bump for security
        constraint = owner.key() == state.owner @ crate::internal::ErrorCode::OnlyOwner // Check owner permission
    )]
    pub state: Account<'info, State>,

    // Must be the challenge owner
    pub owner: Signer<'info>,
}

// Account setup for changing the subscription fee
#[derive(Accounts)]
pub struct UpdateFee<'info> {
    // Find challenge state account
    #[account(
        mut,                    // We will modify this account
        seeds = [b"state", state.owner.as_ref(), &state.challenge_id.to_le_bytes()], // Find it by owner + challenge ID
        bump = state.bump,      // Use stored bump for security
        constraint = owner.key() == state.owner @ crate::internal::ErrorCode::OnlyOwner // Only owner can change fee
    )]
    pub state: Account<'info, State>,

    // Challenge owner (must sign to change fee)
    pub owner: Signer<'info>,
}

// Account setup for changing the commission percentage
#[derive(Accounts)]
pub struct UpdateCommission<'info> {
    // Find challenge state account
    #[account(
        mut,                    // We will modify this account
        seeds = [b"state", state.owner.as_ref(), &state.challenge_id.to_le_bytes()], // Find by owner + challenge ID
        bump = state.bump       // Use stored bump for security
    )]
    pub state: Account<'info, State>,

    // Only the challenge owner can change the commission
    #[account(constraint = owner.key() == state.owner @ crate::internal::ErrorCode::OnlyOwner)]
    pub owner: Signer<'info>,
}

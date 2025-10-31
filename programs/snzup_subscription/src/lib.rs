// Import Anchor framework for Solana 
use anchor_lang::prelude::*;
use anchor_lang::system_program;

// Program ID for testing - backend team should update for mainnet
declare_id!("C2DhNvJ4n4FEDyft6qcK3uDMjoRt5UU9mK41Zmn96VDz");

// Import our helper files
mod internal;  // State data and error handling
mod contexts;  // Account setups for each function

use internal::*;
use contexts::*;

// Helper function for direct lamport transfers from PDA
fn pda_pay<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let mut from_lamports = from.try_borrow_mut_lamports()?;
    let mut to_lamports   = to.try_borrow_mut_lamports()?;

    let new_from_balance = (*from_lamports)
        .checked_sub(amount)
        .ok_or(error!(internal::ErrorCode::InsufficientContractBalance))?;
    let new_to_balance = (*to_lamports)
        .checked_add(amount)
        .ok_or(error!(internal::ErrorCode::LamportMathError))?;

    **from_lamports = new_from_balance;
    **to_lamports = new_to_balance;

    Ok(())
}

// Main 
#[program]
pub mod snzup_subscription {
    use super::*;

    // Create a new challenge 
    pub fn initialize(
        ctx: Context<Initialize>,
        challenge_id: u64,    // Unique number for this challenge
        fee: u64,            // How much people pay to join (in lamports)
        commission: u8,      // Percentage company takes (0-100)
        treasury: Pubkey,    // Treasury wallet for payouts
    ) -> Result<()> {
        // Validate inputs
        require!(treasury != Pubkey::default(), internal::ErrorCode::InvalidInput);
        require!(commission <= 100, internal::ErrorCode::InvalidCommissionRate);
        require!(fee > 0, internal::ErrorCode::InvalidAmount);
        
        // Get the state account we just created
        let s = &mut ctx.accounts.state;
        
        // Set up the challenge with initial values
        s.version = State::CURRENT_VERSION;  // Version number
        s.bump = ctx.bumps.state;           // Security value
        s.challenge_id = challenge_id;      // Store challenge ID
        s.fee = fee;                       // Store entry fee
        s.commission = commission;         // Store commission rate
        s.status = 0;                     // 0 = PENDING (not started yet)
        s.owner = ctx.accounts.owner.key(); // Who created this challenge
        s.treasury = treasury;            // Store treasury wallet
        s.paid = false;                   // Distribution not yet run
        s.op_counter = 0;                 // Count of operations
        s.owners = vec![s.owner];         // List of people who can manage
        s.subscribers = Vec::new();       // Empty list of participants
        s.winners_list = Vec::new();      // Empty list of winners
        
        // Emit initialization event
        emit!(Initialized {
            challenge_id,
            owner: s.owner,
            treasury,
            version: s.version,
        });
        
        Ok(())
    }

    // Join a challenge by paying the fee
    pub fn subscribe(ctx: Context<Subscribe>) -> Result<()> {
        // Get who is joining and how much they need to pay
        let subscriber = ctx.accounts.subscriber.key();
        let fee_amount = {
            let s = &ctx.accounts.state;
            s.fee  // Get the fee amount from challenge state
        };

        // Check if they can join (challenge open, not already joined, etc)
        validate_subscription(&ctx.accounts.state, &subscriber)?;

        // Make sure they have enough SOL to pay the fee
        require!(
            ctx.accounts.subscriber.lamports() >= fee_amount,
            internal::ErrorCode::InsufficientBalance
        );

        // Transfer SOL from subscriber to challenge account
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.subscriber.to_account_info(),  // From subscriber
                to: ctx.accounts.state.to_account_info(),        // To challenge account
            },
        );
        system_program::transfer(cpi, fee_amount)?;

        // Add them to the list of participants
        let s = &mut ctx.accounts.state;
        s.subscribers.push(subscriber);

        // Tell everyone someone joined
        emit!(SubscriptionCreated {
            challenge_id: s.challenge_id,
            subscriber,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // Set who won the challenge 
    pub fn set_winners_list(ctx: Context<OnlyOwner>, winners: Vec<Pubkey>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        
        // Freeze challenge after close - no modifications allowed
        require!(s.status != 2, internal::ErrorCode::InvalidStatus);
        
        let winners_len = winners.len() as u64;
        
        // Add each winner to the list
        for w in winners {
            // Make sure winner address is valid (not empty)
            require!(w != Pubkey::default(), internal::ErrorCode::InvalidWinnerAddress);
            // Make sure no duplicates in existing list
            require!(!s.winners_list.contains(&w), internal::ErrorCode::InvalidInput);
            // Make sure we don't have too many winners
            require!(s.winners_list.len() < State::MAX_WINNERS, internal::ErrorCode::TooManyWinners);
            // Add winner to the list
            s.winners_list.push(w);
        }
        
        // Count this operation to be sure there is no loop
        s.op_counter = s.op_counter.saturating_add(1 + winners_len);
        Ok(())
    }

    // Owner-only
    pub fn remove_owner(ctx: Context<OnlyOwner>, user: Pubkey) -> Result<()> {
        let s = &mut ctx.accounts.state;
        
        // Only allow owner changes while not CLOSED
        require!(s.status != 2, internal::ErrorCode::InvalidStatus);
        
        if let Some(i) = s.owners.iter().position(|x| *x == user) {
            s.owners.remove(i);
        }
        Ok(())
    }

    // Status setter
    pub fn set_status(ctx: Context<OnlyOwner>, status: u8) -> Result<()> {
        // 0=PENDING 1=IN_PROGRESS 2=CLOSED 3=CANCELED
        require!(status <= 3, internal::ErrorCode::InvalidStatus);
        let s = &mut ctx.accounts.state;
        
        // Forbid changing away from CLOSED if paid == true
        if s.paid {
            require!(status == 2, internal::ErrorCode::InvalidStatus);
        }
        
        s.status = status;
        s.op_counter = s.op_counter.saturating_add(1);
        Ok(())
    }

    // Remove subscriber + emit event
    pub fn cancel_subscription(ctx: Context<OnlyOwner>, subscriber: Pubkey) -> Result<()> {
        let s = &mut ctx.accounts.state;
        
        // Freeze challenge after close - no modifications allowed
        require!(s.status != 2, internal::ErrorCode::InvalidStatus);
        
        if let Some(i) = s.subscribers.iter().position(|x| *x == subscriber) {
            s.subscribers.remove(i);
            emit!(SubscriptionCancelled {
                challenge_id: s.challenge_id,
                subscriber,
                timestamp: Clock::get()?.unix_timestamp,
            });
        }
        Ok(())
    }

    // Send prize money to winners and commission to the company
    pub fn send_bonus_to_winners<'info>(
        ctx: Context<'_, '_, '_, 'info, SendBonus<'info>>,
    ) -> Result<()> {
        // Check if the person calling this is allowed to distribute prizes
        validate_allowed_user(&ctx.accounts.owner.key(), &ctx.accounts.state)?;

        let s = &ctx.accounts.state;
        
        // Require distribution hasn't been run yet
        require!(!s.paid, internal::ErrorCode::InvalidStatus);
        
        // Block payout if challenge is canceled
        require!(s.status != 3, internal::ErrorCode::InvalidStatus); // 3 = CANCELED
        
        // Require treasury wallet matches state.treasury
        require!(
            ctx.accounts.treasury_wallet.key() == s.treasury,
            internal::ErrorCode::InvalidInput
        );

        // Calculate how much money we need to keep in account (rent)
        let rent_exempt = Rent::get()?.minimum_balance(State::MAX_SIZE);
        // Get total money in challenge account
        let total = **ctx.accounts.state.to_account_info().lamports.borrow();

        // Make sure we have money to distribute
        require!(total > rent_exempt, internal::ErrorCode::InsufficientContractBalance);

        // Calculate available money (total - rent)
        let available = total - rent_exempt;
        let commission_rate = s.commission as u64;     // Company's cut percentage
        let winners_len = s.winners_list.len() as u64; // How many winners

        require!(available > 0, internal::ErrorCode::InsufficientContractBalance);

        // Calculate company commission (percentage of available money)
        let commission = available * commission_rate / 100;
        let prize_pool = available - commission;
        let bonus_each = if winners_len == 0 { 0 } else { prize_pool / winners_len };
        let leftover = available - commission - (bonus_each * winners_len);

        emit!(CommisionAndBonusCalculation {
            balance: available,
            challenge_balance: prize_pool,
            timestamp: Clock::get()?.unix_timestamp
        });

        emit!(CommisionAndBonusCalculated {
            commission,
            bonus: bonus_each,
            timestamp: Clock::get()?.unix_timestamp
        });

        // Send company commission to treasury wallet
        if commission > 0 {
            pda_pay(
                &ctx.accounts.state.to_account_info(),
                &ctx.accounts.treasury_wallet.to_account_info(),
                commission,
            )?;
        }

        // Validate remaining accounts alignment
        require!(
            ctx.remaining_accounts.len() == winners_len as usize,
            internal::ErrorCode::MissingWinnerAccount
        );

        // Send prize money to each winner
        if bonus_each > 0 {
            for (i, winner) in s.winners_list.iter().enumerate() {
                // Make sure winner address is valid
                require!(*winner != Pubkey::default(), internal::ErrorCode::InvalidWinnerAddress);

                // Get winner's wallet from the accounts passed in
                let win_ai = ctx.remaining_accounts.get(i).unwrap();
                // Make sure the wallet matches the winner address
                require!(*win_ai.key == *winner, internal::ErrorCode::InvalidWinnerAddress);
                // Make sure it's a regular Solana account
                require!(
                    win_ai.owner == &system_program::ID,
                    internal::ErrorCode::InvalidWinnerAddress
                );

                // Send prize money to winner
                pda_pay(
                    &ctx.accounts.state.to_account_info(),
                    &win_ai.to_account_info(),
                    bonus_each,
                )?;

                // Tell this winner got paid
                emit!(BonusSent {
                    challenge_id: s.challenge_id,
                    subscriber: *winner,
                    timestamp: Clock::get()?.unix_timestamp
                });
            }
        }

        // Send commission to treasury
        if leftover > 0 {
            pda_pay(
                &ctx.accounts.state.to_account_info(),
                &ctx.accounts.treasury_wallet.to_account_info(),
                leftover,
            )?;
        }

        // Latch and close
        let s_mut = &mut ctx.accounts.state;
        s_mut.paid = true;
        s_mut.status = 2;  // 2 = CLOSED
        s_mut.op_counter = s_mut.op_counter.saturating_add(1 + winners_len);

        // Emit terminal event for clean archival
        emit!(ChallengeClosed {
            challenge_id: s_mut.challenge_id,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // refund(address[] subscribers) — batch refund
    pub fn refund_batch<'info>(ctx: Context<'_, '_, '_, 'info, RefundBatch<'info>>, subscribers: Vec<Pubkey>) -> Result<()> {
        let s = &ctx.accounts.state;
        
        let rent_exempt = Rent::get()?.minimum_balance(State::MAX_SIZE);
        let total = **ctx.accounts.state.to_account_info().lamports.borrow();
        let available = total.saturating_sub(rent_exempt);

        let need = s
            .fee
            .checked_mul(subscribers.len() as u64)
            .ok_or(error!(internal::ErrorCode::InvalidInput))?;

        require!(available >= need, internal::ErrorCode::InsufficientContractBalance);

        require!(
            ctx.remaining_accounts.len() == subscribers.len(),
            internal::ErrorCode::MissingSubscriberAccount
        );

        for (i, sub) in subscribers.iter().enumerate() {
            require!(*sub != Pubkey::default(), internal::ErrorCode::InvalidSubscriberAddress);

            let sub_ai = ctx.remaining_accounts.get(i).unwrap();
            require!(*sub_ai.key == *sub, internal::ErrorCode::InvalidSubscriberAddress);
            require!(
                sub_ai.owner == &system_program::ID,
                internal::ErrorCode::InvalidSubscriberAddress
            );

            pda_pay(
                &ctx.accounts.state.to_account_info(),
                &sub_ai.to_account_info(),
                s.fee,
            )?;

            emit!(RefundSent {
                challenge_id: s.challenge_id,
                subscriber: *sub,
                timestamp: Clock::get()?.unix_timestamp
            });
        }

        // Remove refunded subscribers from the list 
        let s_mut = &mut ctx.accounts.state;
        s_mut.subscribers.retain(|pk| !subscribers.contains(pk));
        s_mut.op_counter = s_mut.op_counter.saturating_add(1 + subscribers.len() as u64);

        Ok(())
    }

    // getOperationFee() 
    pub fn get_operation_fee(ctx: Context<OnlyOwner>) -> Result<()> {
        emit!(OperationFeeRead { value: ctx.accounts.state.op_counter });
        Ok(())
    }

    // Allow treasury rotation by owner
    pub fn set_treasury(ctx: Context<OnlyOwner>, new_treasury: Pubkey) -> Result<()> {
        require!(new_treasury != Pubkey::default(), internal::ErrorCode::InvalidInput);
        let s = &mut ctx.accounts.state;
        s.treasury = new_treasury;
        s.op_counter = s.op_counter.saturating_add(1);
        Ok(())
    }

    // setCommision(uint8) 
    pub fn set_commision(ctx: Context<UpdateCommission>, commission_percentage: u8) -> Result<()> {
        validate_primary_owner(&ctx.accounts.owner.key(), &ctx.accounts.state.owner)?;
        require!(commission_percentage <= 100, internal::ErrorCode::InvalidCommissionRate);
        
        // Only allow changes while PENDING
        require!(ctx.accounts.state.status == 0, internal::ErrorCode::InvalidStatus);
        
        ctx.accounts.state.commission = commission_percentage;
        ctx.accounts.state.op_counter = ctx.accounts.state.op_counter.saturating_add(1);
        Ok(())
    }

    // setFee(uint256) 
    pub fn set_fee(ctx: Context<UpdateFee>, fee: u64) -> Result<()> {
        validate_primary_owner(&ctx.accounts.owner.key(), &ctx.accounts.state.owner)?;
        require!(fee > 0, internal::ErrorCode::InvalidAmount);
        
        // Only allow changes while PENDING
        require!(ctx.accounts.state.status == 0, internal::ErrorCode::InvalidStatus);
        
        ctx.accounts.state.fee = fee;
        ctx.accounts.state.op_counter = ctx.accounts.state.op_counter.saturating_add(1);
        Ok(())
    }

    // setOwner(address) 
    pub fn set_owner(ctx: Context<OnlyOwner>, new_owner: Pubkey) -> Result<()> {
        let s = &mut ctx.accounts.state;
        
        // Only allow owner changes while not CLOSED
        require!(s.status != 2, internal::ErrorCode::InvalidStatus);
        
        if !s.owners.contains(&new_owner) {
            require!(
                s.owners.len() < State::MAX_OWNERS,
                internal::ErrorCode::TooManyOwners
            );
            s.owners.push(new_owner);
        }
        Ok(())
    }

    // isOwner(address) 
    pub fn is_owner(_ctx: Context<OnlyOwner>) -> Result<()> {
        Ok(())
    }

    // Parity stubs for ERC20 mint getters/setters - Its SOL only - for future
    pub fn get_erc20_mint(_ctx: Context<OnlyOwner>) -> Result<()> {
        Ok(())
    }

    pub fn set_erc20_mint(_ctx: Context<OnlyOwner>, _mint: Pubkey) -> Result<()> {
        Ok(())
    }
}


#[event]
pub struct SubscriptionCreated { 
    pub challenge_id: u64,
    pub subscriber: Pubkey, 
    pub timestamp: i64 
}

#[event]
pub struct SubscriptionCancelled { 
    pub challenge_id: u64,
    pub subscriber: Pubkey, 
    pub timestamp: i64 
}

#[event]
pub struct CommisionAndBonusCalculation { 
    #[index] 
    pub balance: u64, 
    #[index] 
    pub challenge_balance: u64, 
    pub timestamp: i64 
}

#[event]
pub struct CommisionAndBonusCalculated { 
    #[index] 
    pub commission: u64, 
    #[index] 
    pub bonus: u64, 
    pub timestamp: i64 
}

#[event]
pub struct BonusSent { 
    pub challenge_id: u64,
    pub subscriber: Pubkey, 
    pub timestamp: i64 
}

#[event]
pub struct RefundSent {
    pub challenge_id: u64,
    pub subscriber: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct OperationFeeRead {
    pub value: u64,
}

#[event]
pub struct Initialized {
    pub challenge_id: u64,
    pub owner: Pubkey,
    pub treasury: Pubkey,
    pub version: u8,
}

#[event]
pub struct ChallengeClosed {
    pub challenge_id: u64,
    pub timestamp: i64,
}

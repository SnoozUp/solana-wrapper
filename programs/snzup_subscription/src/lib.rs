// Import Anchor framework for Solana 
use anchor_lang::prelude::*;
use anchor_lang::system_program;

// This is our program's unique ID on Solana blockchain
declare_id!("AKMoTiFexNvW3efoiwDcemdraDrnhzfBqTeTL21fVRB9");

// Import our helper files
mod internal;  // State data and error handling
mod contexts;  // Account setups for each function

use internal::*;
use contexts::*;

// Main program
#[program]
pub mod snzup_subscription {
    use super::*;

    // Create a new challenge (like starting a contest)
    pub fn initialize(
        ctx: Context<Initialize>,
        challenge_id: u64,    // Unique number for this challenge
        fee: u64,            // How much people pay to join (in lamports)
        commission: u8,      // Percentage company takes (0-100)
    ) -> Result<()> {
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
        s.op_counter = 0;                 // Count of operations
        s.owners = vec![s.owner];         // List of people who can manage
        s.subscribers = Vec::new();       // Empty list of participants
        s.winners_list = Vec::new();      // Empty list of winners
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
            subscriber,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // Set who won the challenge (only owner can do this)
    pub fn set_winners_list(ctx: Context<OnlyOwner>, winners: Vec<Pubkey>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        
        // Add each winner to the list
        for w in winners {
            // Make sure winner address is valid (not empty)
            require!(w != Pubkey::default(), internal::ErrorCode::InvalidWinnerAddress);
            // Make sure we don't have too many winners
            require!(s.winners_list.len() < State::MAX_WINNERS, internal::ErrorCode::TooManyWinners);
            // Add winner to the list
            s.winners_list.push(w);
        }
        
        // Count this operation
        s.op_counter = s.op_counter.saturating_add(1);
        Ok(())
    }

    // Owner-only
    pub fn remove_owner(ctx: Context<OnlyOwner>, user: Pubkey) -> Result<()> {
        let s = &mut ctx.accounts.state;
        if let Some(i) = s.owners.iter().position(|x| *x == user) {
            s.owners.remove(i);
        }
        Ok(())
    }

    // Explicit status setter
    pub fn set_status(ctx: Context<OnlyOwner>, status: u8) -> Result<()> {
        // 0=PENDING 1=IN_PROGRES 2=CLOSED 3=CANCELED
        require!(status <= 3, internal::ErrorCode::InvalidStatus);
        let s = &mut ctx.accounts.state;
        s.status = status;
        s.op_counter = s.op_counter.saturating_add(1);
        Ok(())
    }

    // Remove subscriber + emit event
    pub fn cancel_subscription(ctx: Context<OnlyOwner>, subscriber: Pubkey) -> Result<()> {
        let s = &mut ctx.accounts.state;
        if let Some(i) = s.subscribers.iter().position(|x| *x == subscriber) {
            s.subscribers.remove(i);
            emit!(SubscriptionCancelled {
                subscriber,
                timestamp: Clock::get()?.unix_timestamp,
            });
        }
        Ok(())
    }

    // Send prize money to winners and commission to company
    pub fn send_bonus_to_winners<'info>(
        ctx: Context<'_, '_, '_, 'info, SendBonus<'info>>,
        snoozup_wallet: Pubkey,  // Company wallet address
    ) -> Result<()> {
        // Check if person calling this is allowed to distribute prizes
        validate_allowed_user(&ctx.accounts.owner.key(), &ctx.accounts.state)?;

        // Make sure company wallet address is valid
        require!(
            snoozup_wallet != Pubkey::default(),
            internal::ErrorCode::InvalidSnoozupWalletAddress
        );
        // Make sure the treasury wallet matches what we expect
        require!(
            ctx.accounts.treasury_wallet.key() == snoozup_wallet,
            internal::ErrorCode::InvalidSnoozupWalletAddress
        );

        let s = &ctx.accounts.state;
        // Calculate how much money we need to keep in account (rent)
        let rent_exempt = Rent::get()?.minimum_balance(State::MAX_SIZE);
        // Get total money in challenge account
        let total = **ctx.accounts.state.to_account_info().lamports.borrow();

        // Make sure we have money to distribute
        require!(total > rent_exempt, internal::ErrorCode::InsufficientContractBalance);

        // Calculate available money (total minus rent)
        let available = total - rent_exempt;
        let commission_rate = s.commission;     // Company's cut percentage
        let winners = s.winners_list.clone();  // List of winners
        let winners_len = winners.len() as u64; // How many winners

        require!(available > 0, internal::ErrorCode::InsufficientContractBalance);

        // Calculate company commission (percentage of available money)
        let commission_rate_u64 = commission_rate as u64;
        let commission = available
            .checked_mul(commission_rate_u64)  // Multiply by percentage
            .ok_or(error!(internal::ErrorCode::InvalidInput))?
            / 100;  // Divide by 100 to get actual percentage

        // Make sure commission isn't more than available money
        require!(commission <= available, internal::ErrorCode::InvalidInput);

        // Money left for winners after taking commission
        let challenge_balance = available - commission;

        emit!(CommisionAndBonusCalculation {
            balance: available,
            challenge_balance,
            timestamp: Clock::get()?.unix_timestamp
        });

        // Calculate how much each winner gets
        let bonus_each = if winners_len == 0 {
            0  // No winners = no prize money
        } else {
            challenge_balance / winners_len  // Split money equally among winners
        };

        emit!(CommisionAndBonusCalculated {
            commission,
            bonus: bonus_each,
            timestamp: Clock::get()?.unix_timestamp
        });

        let owner_ref = s.owner.as_ref();
        let cid = s.challenge_id.to_le_bytes();
        let bump_arr = [s.bump];
        let signer = &[&[b"state", owner_ref, &cid, &bump_arr][..]];

        // Send company commission to treasury wallet
        if commission > 0 {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.state.to_account_info(),      // From challenge account
                    to: ctx.accounts.treasury_wallet.to_account_info(), // To company wallet
                },
                signer,  // Challenge account signs the transfer
            );
            system_program::transfer(cpi_ctx, commission)?;
        }

        require!(
            ctx.remaining_accounts.len() == winners.len(),
            internal::ErrorCode::MissingWinnerAta
        );

        // Send prize money to each winner
        if bonus_each > 0 {
            for (i, winner) in winners.iter().enumerate() {
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
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.state.to_account_info(), // From challenge account
                        to: win_ai.to_account_info(),              // To winner's wallet
                    },
                    signer,  // Challenge account signs the transfer
                );
                system_program::transfer(cpi_ctx, bonus_each)?;

                // Tell everyone this winner got paid
                emit!(BonusSent {
                    subscriber: *winner,
                    timestamp: Clock::get()?.unix_timestamp
                });
            }
        }

        // Send remaining balance to treasury
        let remaining = available - commission - (bonus_each * winners_len);
        if remaining > 0 {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.state.to_account_info(),
                    to: ctx.accounts.treasury_wallet.to_account_info(),
                },
                signer,
            );
            system_program::transfer(cpi_ctx, remaining)?;
        }

        // Mark challenge as closed
        ctx.accounts.state.status = 2;  // 2 = CLOSED

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

        let owner_ref = s.owner.as_ref();
        let cid = s.challenge_id.to_le_bytes();
        let bump_arr = [s.bump];
        let signer = &[&[b"state", owner_ref, &cid, &bump_arr][..]];

        require!(
            ctx.remaining_accounts.len() == subscribers.len(),
            internal::ErrorCode::MissingSubscriberAta
        );

        for (i, sub) in subscribers.iter().enumerate() {
            require!(*sub != Pubkey::default(), internal::ErrorCode::InvalidSubscriberAddress);

            let sub_ai = ctx.remaining_accounts.get(i).unwrap();
            require!(*sub_ai.key == *sub, internal::ErrorCode::InvalidSubscriberAddress);
            require!(
                sub_ai.owner == &system_program::ID,
                internal::ErrorCode::InvalidSubscriberAddress
            );

            let state_account = &ctx.accounts.state;
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: state_account.to_account_info(),
                    to: sub_ai.to_account_info(),
                },
                signer,
            );
            system_program::transfer(cpi_ctx, s.fee)?;

            emit!(RefundSent {
                subscriber: *sub,
                timestamp: Clock::get()?.unix_timestamp
            });
        }

        let s_mut = &mut ctx.accounts.state;
        s_mut.subscribers.retain(|pk| !subscribers.contains(pk));
        s_mut.op_counter = s_mut.op_counter.saturating_add(1);

        Ok(())
    }

    // getOperationFee() 
    pub fn get_operation_fee(ctx: Context<OnlyOwner>) -> Result<()> {
        emit!(OperationFeeRead { value: ctx.accounts.state.op_counter });
        Ok(())
    }

    // withdraw() - Only owner can withdraw
    pub fn withdraw_funds(ctx: Context<WithdrawFunds>) -> Result<()> {
        let s = &ctx.accounts.state;
        let rent_exempt = Rent::get()?.minimum_balance(State::MAX_SIZE);
        let total = **ctx.accounts.state.to_account_info().lamports.borrow();

        require!(total > rent_exempt, internal::ErrorCode::NoUsdcAvailable);

        let amount = total - rent_exempt;
        require!(amount > 0, internal::ErrorCode::NoUsdcAvailable);

        let owner_ref = s.owner.as_ref();
        let cid = s.challenge_id.to_le_bytes();
        let bump_arr = [s.bump];
        let signer = &[&[b"state", owner_ref, &cid, &bump_arr][..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.state.to_account_info(),
                to: ctx.accounts.owner.to_account_info(),
            },
            signer,
        );
        system_program::transfer(cpi_ctx, amount)
            .map_err(|_| error!(internal::ErrorCode::UsdcTransferFailed))?;

        Ok(())
    }

    // setCommision(uint8) 
    pub fn set_commision(ctx: Context<UpdateCommission>, commission_percentage: u8) -> Result<()> {
        validate_primary_owner(&ctx.accounts.owner.key(), &ctx.accounts.state.owner)?;
        ctx.accounts.state.commission = commission_percentage;
        Ok(())
    }

    // setFee(uint256) 
    pub fn set_fee(ctx: Context<UpdateFee>, fee: u64) -> Result<()> {
        validate_primary_owner(&ctx.accounts.owner.key(), &ctx.accounts.state.owner)?;
        ctx.accounts.state.fee = fee;
        Ok(())
    }

    // setOwner(address) 
    pub fn set_owner(ctx: Context<OnlyOwner>, new_owner: Pubkey) -> Result<()> {
        let s = &mut ctx.accounts.state;
        if !s.owners.contains(&new_owner) {
            require!(
                s.owners.len() < State::MAX_OWNERS,
                internal::ErrorCode::TooManyOwners
            );
            s.owners.push(new_owner);
        }
        Ok(())
    }

    // isOwner(address) - bool  
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
    pub subscriber: Pubkey, 
    pub timestamp: i64 
}

#[event]
pub struct SubscriptionCancelled { 
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
    pub subscriber: Pubkey, 
    pub timestamp: i64 
}

#[event]
pub struct RefundSent {
    pub subscriber: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct OperationFeeRead {
    pub value: u64,
}

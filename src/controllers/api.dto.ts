import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNumber, IsString, ArrayNotEmpty } from 'class-validator';

export class InitializeDto {
  @ApiProperty({ ex: '1', description: 'Unique challenge identifier' })
  @IsString()
  challengeId: string;

  @ApiProperty({ ex: '100000000', description: 'Entry fee in lamports' })
  @IsString()
  fee: string;

  @ApiProperty({ ex: 10, description: 'Commission percentage (0-100)' })
  @IsNumber()
  commission: number;
}

export class BuildSubscribeDto {
  @ApiProperty({ ex: 'EXAMPLE_USER_PUBKEY', description: 'User wallet public key (base58)' })
  @IsString()
  subscriber: string;
}

export class WinnersDto {
  @ApiProperty({ 
    type: [String], 
    example: ['EXAMPLE_USER_PUBKEY', 'EXAMPLE_USER_PUBKEY_2'],
    description: 'Array of winner wallet public keys (base58)'
  })
  @IsArray()
  @ArrayNotEmpty()
  winners: string[];
}

export class RefundBatchDto {
  @ApiProperty({ 
    type: [String], 
    example: ['EXAMPLE_USER_PUBKEY', 'EXAMPLE_USER_PUBKEY_2'],
    description: 'Array of subscriber wallet public keys to refund (base58)'
  })
  @IsArray()
  @ArrayNotEmpty()
  subscribers: string[];
}

export class SetFeeDto {
  @ApiProperty({ ex: '200000000', description: 'New entry fee in lamports' })
  @IsString()
  fee: string;
}

export class SetCommissionDto {
  @ApiProperty({ ex: 15, description: 'New commission % (0-100)' })
  @IsNumber()
  commissionPercentage: number;
}

export class SetStatusDto {
  @ApiProperty({ 
    example: 2, 
    description: 'Challenge status: 0=PENDING, 1=IN_PROGRESS, 2=CLOSED, 3=CANCELED' 
  })
  @IsNumber()
  status: number;
}

export class CancelSubscriptionDto {
  @ApiProperty({ ex: 'EXAMPLE_USER_PUBKEY', description: 'Subscriber wallet public key to cancel (base58)' })
  @IsString()
  subscriber: string;
}

export class SetOwnerDto {
  @ApiProperty({ ex: 'EXAMPLE_USER_PUBKEY', description: 'New owner wallet public key (base58)' })
  @IsString()
  newOwner: string;
}

export class RemoveOwnerDto {
  @ApiProperty({ exe: 'EXAMPLE_USER_PUBKEY', description: 'Owner wallet public key to remove (base58)' })
  @IsString()
  user: string;
}

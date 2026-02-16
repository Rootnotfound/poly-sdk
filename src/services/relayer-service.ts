/**
 * RelayerService
 *
 * Wrapper around Polymarket Builder Relayer Client for gasless on-chain operations.
 * Enables Gnosis Safe smart contract wallet operations paid by Polymarket Relayer.
 *
 * Benefits:
 * - Gasless transactions (Polymarket pays gas)
 * - Builder attribution (fee sharing + weekly rewards)
 * - Daily transaction limits by tier (Unverified: 100/day, Verified: 1500/day)
 *
 * Operations:
 * - deploySafe: Deploy Gnosis Safe smart contract wallet
 * - approveUsdc: Approve USDC.e for CTF operations
 * - split: USDC → YES + NO tokens
 * - merge: YES + NO → USDC
 * - redeem: Winning tokens → USDC
 *
 * Based on: @polymarket/builder-relayer-client v0.0.8
 */

import { RelayClient } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { ethers, Wallet, BigNumber } from 'ethers';
import {
  CTF_CONTRACT,
  USDC_CONTRACT,
  USDC_DECIMALS,
} from '../clients/ctf-client.js';

// ============================================================================
// Types
// ============================================================================

export interface RelayerServiceConfig {
  /** Builder API credentials */
  builderCreds: {
    key: string;
    secret: string;
    passphrase: string;
  };
  /** Private key for signing relayer requests (EOA that owns the Safe) */
  privateKey: string;
  /** Chain ID (default: 137 for Polygon) */
  chainId?: number;
  /** Relayer endpoint URL */
  relayerUrl?: string;
}

/**
 * Relayer transaction state machine
 * See: @polymarket/builder-relayer-client types
 */
export enum RelayerState {
  NEW = 'STATE_NEW',
  EXECUTED = 'STATE_EXECUTED',
  MINED = 'STATE_MINED',
  CONFIRMED = 'STATE_CONFIRMED',
  FAILED = 'STATE_FAILED',
  INVALID = 'STATE_INVALID',
}

export interface RelayerResult {
  success: boolean;
  txHash?: string;
  errorMessage?: string;
}

export interface SafeDeployResult extends RelayerResult {
  safeAddress: string;
}

// ============================================================================
// CTF ABIs (reused from ctf-client.ts)
// ============================================================================

const CTF_ABI = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
];

// ============================================================================
// RelayerService Implementation
// ============================================================================

export class RelayerService {
  private relayClient: RelayClient;
  private wallet: Wallet;
  private chainId: number;

  constructor(config: RelayerServiceConfig) {
    this.chainId = config.chainId || 137;
    this.wallet = new Wallet(config.privateKey);

    const relayerUrl = config.relayerUrl || 'https://relayer-v2.polymarket.com/';

    // Construct BuilderConfig
    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: config.builderCreds.key,
        secret: config.builderCreds.secret,
        passphrase: config.builderCreds.passphrase,
      },
    });

    // Initialize RelayClient with Builder credentials
    // RelayClient constructor signature:
    // constructor(relayerUrl, chainId, signer?, builderConfig?, relayTxType?)
    this.relayClient = new RelayClient(
      relayerUrl,
      this.chainId,
      this.wallet,
      builderConfig
    );
  }

  /**
   * Get the EOA address (signer)
   */
  getSignerAddress(): string {
    return this.wallet.address;
  }

  /**
   * Deploy a Gnosis Safe smart contract wallet
   *
   * The Safe becomes the asset holder for CTF operations.
   * Safe owner is the EOA (this.wallet.address).
   *
   * @returns SafeDeployResult with deployed Safe address
   *
   * @example
   * ```typescript
   * const result = await relayer.deploySafe();
   * console.log(`Safe deployed: ${result.safeAddress}`);
   * ```
   */
  async deploySafe(): Promise<SafeDeployResult> {
    try {
      const response = await this.relayClient.deploy();

      // Wait for confirmation
      const tx = await response.wait();

      if (!tx) {
        return {
          success: false,
          safeAddress: '',
          errorMessage: 'Deployment failed: No transaction returned',
        };
      }

      if (tx.state === RelayerState.FAILED) {
        return {
          success: false,
          safeAddress: '',
          errorMessage: `Safe deployment failed: ${tx.state}`,
        };
      }

      // Safe address should be in tx.to for safe deployments
      const safeAddress = tx.to;
      if (!safeAddress) {
        return {
          success: false,
          safeAddress: '',
          errorMessage: 'Safe address not found in transaction',
        };
      }

      return {
        success: true,
        safeAddress,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        safeAddress: '',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Approve USDC.e for CTF operations
   *
   * @param spender - Spender address (typically CTF_CONTRACT)
   * @param amount - Amount to approve (use MaxUint256 for unlimited)
   */
  async approveUsdc(spender: string, amount: BigNumber): Promise<RelayerResult> {
    const usdcInterface = new ethers.utils.Interface(ERC20_ABI);
    const data = usdcInterface.encodeFunctionData('approve', [spender, amount]);

    try {
      const response = await this.relayClient.execute([{
        to: USDC_CONTRACT,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED) {
        return {
          success: false,
          errorMessage: `USDC approval failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Split USDC into YES + NO tokens (gasless)
   *
   * @param conditionId - Market condition ID
   * @param amount - USDC amount in human-readable format (e.g., "100" for 100 USDC)
   * @returns RelayerResult with transaction status
   *
   * @example
   * ```typescript
   * const result = await relayer.split(conditionId, "100");
   * if (result.success) {
   *   console.log(`Split tx: ${result.txHash}`);
   * }
   * ```
   */
  async split(conditionId: string, amount: string): Promise<RelayerResult> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
    const ctfInterface = new ethers.utils.Interface(CTF_ABI);

    const data = ctfInterface.encodeFunctionData('splitPosition', [
      USDC_CONTRACT,
      ethers.constants.HashZero, // parentCollectionId
      conditionId,
      [1, 2], // partition [YES, NO]
      amountWei,
    ]);

    try {
      const response = await this.relayClient.execute([{
        to: CTF_CONTRACT,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED) {
        return {
          success: false,
          errorMessage: `Split failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Merge YES + NO tokens back to USDC (gasless)
   *
   * @param conditionId - Market condition ID
   * @param amount - Number of token pairs to merge (e.g., "100" for 100 YES + 100 NO)
   * @returns RelayerResult with transaction status
   */
  async merge(conditionId: string, amount: string): Promise<RelayerResult> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
    const ctfInterface = new ethers.utils.Interface(CTF_ABI);

    const data = ctfInterface.encodeFunctionData('mergePositions', [
      USDC_CONTRACT,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
      amountWei,
    ]);

    try {
      const response = await this.relayClient.execute([{
        to: CTF_CONTRACT,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED) {
        return {
          success: false,
          errorMessage: `Merge failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Redeem winning tokens to USDC (gasless)
   *
   * @param conditionId - Market condition ID
   * @param outcome - Winning outcome ('YES' or 'NO')
   * @returns RelayerResult with transaction status
   */
  async redeem(conditionId: string, outcome: 'YES' | 'NO'): Promise<RelayerResult> {
    const indexSets = outcome === 'YES' ? [1] : [2];
    const ctfInterface = new ethers.utils.Interface(CTF_ABI);

    const data = ctfInterface.encodeFunctionData('redeemPositions', [
      USDC_CONTRACT,
      ethers.constants.HashZero,
      conditionId,
      indexSets,
    ]);

    try {
      const response = await this.relayClient.execute([{
        to: CTF_CONTRACT,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED) {
        return {
          success: false,
          errorMessage: `Redeem failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Execute a batch of generic transactions via Relayer (gasless)
   *
   * @param transactions - Array of transactions to execute
   */
  async executeBatch(
    transactions: Array<{ to: string; data: string; value: string }>
  ): Promise<RelayerResult> {
    try {
      const response = await this.relayClient.execute(transactions);
      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED) {
        return {
          success: false,
          errorMessage: `Batch execution failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

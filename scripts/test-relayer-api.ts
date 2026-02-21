#!/usr/bin/env tsx

// Explore @polymarket/builder-relayer-client API
import { RelayClient } from '@polymarket/builder-relayer-client';
import { Wallet } from 'ethers';

console.log('RelayClient:', RelayClient);
console.log('RelayClient methods:', Object.getOwnPropertyNames(RelayClient.prototype));

// Try creating an instance
const wallet = new Wallet('0x' + '1'.repeat(64));
try {
  const client = new RelayClient(
    'test-key',
    'test-secret',
    'test-passphrase',
    wallet,
    137
  );
  console.log('RelayClient instance created:', Object.getOwnPropertyNames(Object.getPrototypeOf(client)));
} catch (error) {
  console.log('Error creating RelayClient:', error);
}

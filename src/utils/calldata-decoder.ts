/**
 * Polymarket settlement TX calldata decoder.
 *
 * Decodes `matchOrders` calldata from pending/mined TXs to extract
 * maker/taker addresses, token IDs, and order details.
 *
 * Both CTF Router (0xE3f18aCc55091e2c48d883fc8C8413319d4Ab7b0) and
 * NegRisk Router (0xB768891e3130F6dF18214Ac804d4DB76c2C37730) use
 * the FeeModule's matchOrders with selector 0x2287e350.
 *
 * @see https://github.com/Polymarket/exchange-fee-module
 */

import { ethers } from 'ethers';

// ============================================================
// Constants
// ============================================================

/** CTF Router (FeeModule) — operators send settlement TXs here */
export const CTF_ROUTER = '0xE3f18aCc55091e2c48d883fc8C8413319d4Ab7b0';
/** NegRisk Router (FeeModule) — operators send NegRisk settlement TXs here */
export const NEG_RISK_ROUTER = '0xB768891e3130F6dF18214Ac804d4DB76c2C37730';

/** Both routers use the same matchOrders selector */
export const MATCH_ORDERS_SELECTOR = '0x2287e350';

/** Set of router addresses (lowercase) for quick lookup */
export const ROUTER_ADDRESSES = new Set([
  CTF_ROUTER.toLowerCase(),
  NEG_RISK_ROUTER.toLowerCase(),
]);

// ============================================================
// ABI
// ============================================================

/** Order struct tuple type (13 fields per CTF Exchange Order struct) */
const ORDER_TUPLE =
  'tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)';

/**
 * FeeModule matchOrders ABI (7 params).
 * Selector: keccak256("matchOrders((uint256,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8,bytes),(uint256,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8,bytes)[],uint256,uint256,uint256[],uint256,uint256[])") = 0x2287e350
 */
const MATCH_ORDERS_IFACE = new ethers.utils.Interface([
  `function matchOrders(
    ${ORDER_TUPLE} takerOrder,
    ${ORDER_TUPLE}[] makerOrders,
    uint256 takerFillAmount,
    uint256 makerFillAmount,
    uint256[] makerFillAmounts,
    uint256 takerFeeAmount,
    uint256[] makerFeeAmounts
  )`,
]);

// ============================================================
// Types
// ============================================================

/** Side enum matching CTF Exchange contract */
export enum OrderSide {
  BUY = 0,
  SELL = 1,
}

/** Decoded order info (subset of fields relevant for copy-trading) */
export interface DecodedOrder {
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: OrderSide;
}

/** Result of decoding matchOrders calldata */
export interface DecodedMatchOrders {
  /** The taker (active) order */
  takerOrder: DecodedOrder;
  /** All maker (passive) orders */
  makerOrders: DecodedOrder[];
  takerFillAmount: string;
  makerFillAmounts: string[];
}

// ============================================================
// Decoder
// ============================================================

function decodeOrder(raw: any): DecodedOrder {
  return {
    maker: raw.maker.toLowerCase(),
    signer: raw.signer.toLowerCase(),
    taker: raw.taker.toLowerCase(),
    tokenId: raw.tokenId.toString(),
    makerAmount: raw.makerAmount.toString(),
    takerAmount: raw.takerAmount.toString(),
    side: Number(raw.side) as OrderSide,
  };
}

/**
 * Decode matchOrders calldata from a settlement TX.
 * Returns null if the data doesn't start with the matchOrders selector or decoding fails.
 */
export function decodeMatchOrdersCalldata(data: string): DecodedMatchOrders | null {
  try {
    if (!data.startsWith(MATCH_ORDERS_SELECTOR)) return null;
    const decoded = MATCH_ORDERS_IFACE.decodeFunctionData('matchOrders', data);
    return {
      takerOrder: decodeOrder(decoded.takerOrder),
      makerOrders: decoded.makerOrders.map(decodeOrder),
      takerFillAmount: decoded.takerFillAmount.toString(),
      makerFillAmounts: decoded.makerFillAmounts.map((a: any) => a.toString()),
    };
  } catch {
    return null;
  }
}

/**
 * Check if a TX is a settlement TX (sent to a Router contract).
 */
export function isSettlementTx(to: string | null | undefined): boolean {
  return !!to && ROUTER_ADDRESSES.has(to.toLowerCase());
}

/**
 * Extract all unique trader addresses from decoded matchOrders calldata.
 * Returns lowercase addresses.
 */
export function extractTraderAddresses(decoded: DecodedMatchOrders): string[] {
  const addresses = new Set<string>();
  addresses.add(decoded.takerOrder.maker);
  if (decoded.takerOrder.signer !== decoded.takerOrder.maker) {
    addresses.add(decoded.takerOrder.signer);
  }
  for (const order of decoded.makerOrders) {
    addresses.add(order.maker);
    if (order.signer !== order.maker) {
      addresses.add(order.signer);
    }
  }
  return Array.from(addresses);
}

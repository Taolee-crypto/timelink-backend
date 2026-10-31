/** Exact unit validation for TL -> TLC escrow. No floating point asset math. */
export function parseWholeTL(value:unknown):number {
 if(typeof value!=='string'||!/^[1-9][0-9]*$/.test(value))throw new Error('INVALID_WHOLE_TL');
 const amount=Number(value);
 if(!Number.isSafeInteger(amount))throw new Error('TL_AMOUNT_OVERFLOW');
 return amount;
}
export function parseTLCAtoms(value:unknown):bigint {
 if(typeof value!=='string'||!/^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,9})?$/.test(value))throw new Error('INVALID_TLC_AMOUNT');
 const [whole,fraction='']=value.split('.');
 const atoms=BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0')||'0');
 if(atoms<=0n||atoms>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('TLC_AMOUNT_OUT_OF_RANGE');
 return atoms;
}
export function calculateTLCAtoms(tl:number,rateAtomsPerTL:number):number {
 if(!Number.isSafeInteger(tl)||tl<=0||!Number.isSafeInteger(rateAtomsPerTL)||rateAtomsPerTL<=0)throw new Error('INVALID_EXCHANGE_QUOTE');
 const result=BigInt(tl)*BigInt(rateAtomsPerTL);
 if(result>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('EXCHANGE_QUOTE_OVERFLOW');
 return Number(result);
}
export function validateQuoteExpiry(expiresAt:string,now:number=Date.now()):void {
 const expiry=Date.parse(expiresAt);
 if(!Number.isFinite(expiry)||expiry<=now||expiry>now+5*60*1000)throw new Error('EXPIRED_OR_INVALID_QUOTE');
}

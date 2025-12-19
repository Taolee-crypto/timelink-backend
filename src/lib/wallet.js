export class VirtualWallet {
  constructor(kv) {
    this.kv = kv;
  }
  
  async getBalance(address) {
    const data = await this.kv.get(`wallet:${address}`, 'json');
    return data ? data.balance : 0;
  }
  
  async charge(address, amount) {
    const currentBalance = await this.getBalance(address);
    const newBalance = currentBalance + parseFloat(amount);
    
    await this.kv.put(`wallet:${address}`, JSON.stringify({
      address,
      balance: newBalance,
      lastUpdated: new Date().toISOString()
    }));
    
    // 트랜잭션 기록
    await this.recordTransaction({
      from: 'system',
      to: address,
      amount: amount,
      type: 'charge'
    });
    
    return newBalance;
  }
  
  async deduct(address, amount) {
    const currentBalance = await this.getBalance(address);
    
    if (currentBalance < amount) {
      throw new Error('Insufficient balance');
    }
    
    const newBalance = currentBalance - amount;
    await this.kv.put(`wallet:${address}`, JSON.stringify({
      address,
      balance: newBalance,
      lastUpdated: new Date().toISOString()
    }));
    
    return newBalance;
  }
  
  async distributeEarnings(fromAddress, uploaderAddress, copyrightAddress, totalAmount) {
    // 60% 업로더, 40% 저작권자 (분배 비율 조정 가능)
    const uploaderShare = totalAmount * 0.6;
    const copyrightShare = totalAmount * 0.4;
    
    // 사용자 잔액 차감
    await this.deduct(fromAddress, totalAmount);
    
    // 업로더에게 분배
    await this.charge(uploaderAddress, uploaderShare);
    
    // 저작권자에게 분배
    await this.charge(copyrightAddress, copyrightShare);
    
    // 트랜잭션 기록
    await this.recordTransaction({
      from: fromAddress,
      to: uploaderAddress,
      amount: uploaderShare,
      type: 'distribution',
      role: 'uploader'
    });
    
    await this.recordTransaction({
      from: fromAddress,
      to: copyrightAddress,
      amount: copyrightShare,
      type: 'distribution',
      role: 'copyright'
    });
    
    return {
      totalAmount,
      uploaderShare,
      copyrightShare,
      fromAddress,
      uploaderAddress,
      copyrightAddress
    };
  }
  
  async recordTransaction(tx) {
    const txId = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    await this.kv.put(`transaction:${txId}`, JSON.stringify({
      id: txId,
      ...tx,
      timestamp: new Date().toISOString()
    }));
  }
}

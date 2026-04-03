/**
 * NDMS Blockchain - Alert Audit Trail
 * Immutable record of all disaster alerts
 */

const crypto = require('crypto');

class BlockchainAudit {
  constructor() {
    this.chain = [];
    this.pendingAlerts = [];
    this.isTestMode = true; // Using simulated blockchain for prototype
    
    // Create genesis block
    this.createGenesisBlock();
  }

  /**
   * Create the first block in the chain
   */
  createGenesisBlock() {
    const genesis = {
      index: 0,
      timestamp: new Date().toISOString(),
      alert: { type: 'GENESIS', message: 'NDMS Alert Audit System Initialized' },
      previousHash: '0',
      hash: this.calculateHash(0, '0', {}),
      validator: 'system'
    };
    this.chain.push(genesis);
  }

  /**
   * Calculate block hash
   */
  calculateHash(index, previousHash, alert) {
    const data = `${index}${previousHash}${JSON.stringify(alert)}${Date.now()}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Add new alert to blockchain
   * @param {Object} alert - Alert data {type, severity, location, message, adminId}
   * @param {string} adminWallet - Admin wallet address
   * @returns {Object} Block with transaction hash
   */
  addAlert(alert, adminWallet = 'admin-1') {
    const timestamp = new Date().toISOString();
    const previousBlock = this.chain[this.chain.length - 1];
    const index = this.chain.length;
    
    const block = {
      index: index,
      timestamp: timestamp,
      alert: {
        id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: alert.type || 'GENERAL',
        severity: alert.severity || 'low',
        location: alert.location || 'Unknown',
        message: alert.message || '',
        issuedBy: adminWallet,
        issuedAt: timestamp
      },
      previousHash: previousBlock.hash,
      hash: '',
      validator: adminWallet,
      transactionHash: this.generateTransactionHash(alert, adminWallet)
    };
    
    // Calculate hash
    block.hash = this.calculateHash(block.index, block.previousHash, block.alert);
    
    // Add to chain
    this.chain.push(block);
    
    console.log(`[Blockchain] Block #${index} added | TX: ${block.transactionHash.substring(0, 16)}...`);
    
    return block;
  }

  /**
   * Generate transaction hash for alert
   */
  generateTransactionHash(alert, wallet) {
    const data = `${JSON.stringify(alert)}${wallet}${Date.now()}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Verify if a block is valid and hasn't been tampered
   * @param {number} index - Block index
   * @returns {Object} Verification result
   */
  verifyBlock(index) {
    if (index < 0 || index >= this.chain.length) {
      return { valid: false, error: 'Block not found' };
    }
    
    const block = this.chain[index];
    const recalculatedHash = this.calculateHash(block.index, block.previousHash, block.alert);
    
    return {
      valid: block.hash === recalculatedHash,
      block: block,
      message: block.hash === recalculatedHash 
        ? 'Block verified - No tampering detected'
        : 'WARNING: Block may have been tampered!'
    };
  }

  /**
   * Verify entire chain integrity
   */
  verifyChain() {
    for (let i = 1; i < this.chain.length; i++) {
      const current = this.chain[i];
      const previous = this.chain[i - 1];
      
      if (current.previousHash !== previous.hash) {
        return { valid: false, error: `Chain broken at block ${i}` };
      }
      
      if (current.hash !== this.calculateHash(current.index, current.previousHash, current.alert)) {
        return { valid: false, error: `Hash mismatch at block ${i}` };
      }
    }
    
    return { valid: true, blocks: this.chain.length };
  }

  /**
   * Get all alerts from blockchain
   */
  getAllAlerts() {
    return this.chain
      .filter(block => block.index > 0) // Exclude genesis
      .map(block => ({
        ...block.alert,
        blockIndex: block.index,
        blockHash: block.hash,
        transactionHash: block.transactionHash,
        verified: true
      }));
  }

  /**
   * Get recent alerts
   */
  getRecentAlerts(limit = 10) {
    return this.getAllAlerts().slice(-limit).reverse();
  }

  /**
   * Get alert by transaction hash
   */
  getAlertByHash(txHash) {
    return this.chain.find(block => block.transactionHash === txHash);
  }

  /**
   * Get blockchain statistics
   */
  getStats() {
    const chainStatus = this.verifyChain();
    const alerts = this.getAllAlerts();
    
    return {
      totalBlocks: this.chain.length,
      totalAlerts: alerts.length,
      chainValid: chainStatus.valid,
      lastBlockTime: this.chain[this.chain.length - 1]?.timestamp,
      bySeverity: {
        high: alerts.filter(a => a.severity === 'high').length,
        medium: alerts.filter(a => a.severity === 'medium').length,
        low: alerts.filter(a => a.severity === 'low').length
      }
    };
  }

  /**
   * Export chain for backup
   */
  exportChain() {
    return JSON.stringify(this.chain, null, 2);
  }

  /**
   * Import chain (for recovery)
   */
  importChain(chainData) {
    try {
      this.chain = JSON.parse(chainData);
      return { success: true, blocks: this.chain.length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

// Singleton instance
const blockchainAudit = new BlockchainAudit();

module.exports = blockchainAudit;

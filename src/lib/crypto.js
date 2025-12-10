export class TimeLinkCrypto {
  static async generateKeyPair() {
    return {
      publicKey: 'pub_key_' + Math.random().toString(36).substr(2, 8),
      privateKey: 'priv_key_' + Math.random().toString(36).substr(2, 8)
    };
  }
}

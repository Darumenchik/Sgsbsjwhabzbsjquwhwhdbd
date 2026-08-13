(function(){
  const encryptedPayload = 'U2FsdGVkX19BJ3AuMHUlQd5oGzz1CxNLYurBBiado54r7z2vXsDS7hY+/nQCZ1KMbl6XM9qKWLSjT3EEV3X/udHjsT78v4TH9JTyK1OIV99RX1rOnVIvSamiCLGFlnnVFem76wDZjN4rHVZDX1YYT2igld1GOikq2kYCMHkwnQgQ9/h27H4UzwTJZRB+a79+Xqvcd54L4/NH1/0CKVLqfRowyIT2wesjpAWIQwYNQykQMRn5Qh7SoYD6uRzn1p9dWW4WwQEpZNjRVU7FW62pyjj2zVsdQ8VjssWL8WDtTdB0Lc7ZASgOr6+jtrLtZy+Q+cm8n74QAGB9MmnEltlWENJssqoeEM20tviSMcZl+PN0iw+lyrHC06/9rJumHIF2xa/+EKNXpol7k5a9Wl7yN8Okdyva7qe8x0wW+1SuaM39zGeMA3g4Zp11n61ENuxx';
  const secret = 'chiper-otp-secret-2026';
  function getBytes(str){ return CryptoJS.enc.Utf8.parse(str); }
  function decodeBase64(str){ return CryptoJS.enc.Base64.parse(str); }
  function evp_kdf(password, salt, keySize, ivSize){
    let key = CryptoJS.lib.WordArray.create();
    let prev = CryptoJS.lib.WordArray.create();
    while(key.words.length * 4 < (keySize + ivSize)){
      const md5 = CryptoJS.MD5(prev.concat(password).concat(salt));
      prev = md5;
      key = key.concat(md5);
    }
    return {
      key: CryptoJS.lib.WordArray.create(key.words.slice(0, keySize / 4)),
      iv: CryptoJS.lib.WordArray.create(key.words.slice(keySize / 4, (keySize + ivSize) / 4)),
    };
  }
  function decryptPayload(payload){
    const data = decodeBase64(payload);
    const salt = CryptoJS.lib.WordArray.create(data.words.slice(2, 4));
    const ciphertext = CryptoJS.lib.WordArray.create(data.words.slice(4));
    const derived = evp_kdf(getBytes(secret), salt, 32, 16);
    const decrypted = CryptoJS.AES.decrypt({ ciphertext }, derived, { iv: derived.iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    return decrypted.toString(CryptoJS.enc.Utf8);
  }
  try{
    const json = decryptPayload(encryptedPayload);
    window.__APP_ENV__ = JSON.parse(json);
  }catch(e){
    console.warn('env.js: не удалось расшифровать конфигурацию', e);
    window.__APP_ENV__ = {};
  }
})();

/**
 * New user consent is validated on the server, not trusted merely because
 * the signup screen hides its submit button. Do not store unchecked
 * optional marketing consent as affirmative.
 */
export interface V5RegistrationConsent {
  terms: true;
  privacy: true;
  age14: true;
  marketing: boolean;
}
export function parseRegistrationConsent(input:unknown):V5RegistrationConsent|null {
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  const data=input as Record<string,unknown>;
  if(data.consent_terms!==true||
     data.consent_privacy!==true||
     data.age_14_confirmed!==true)return null;
  if(data.marketing!==undefined&&typeof data.marketing!=='boolean')return null;
  return {terms:true,privacy:true,age14:true,marketing:data.marketing===true};
}
export async function ensureV5SignupConsentAudit(db:D1Database):Promise<void>{
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS v5_signup_consents ('+
    'user_id INTEGER PRIMARY KEY REFERENCES users(id),'+
    'terms_accepted INTEGER NOT NULL CHECK(terms_accepted=1),'+
    'privacy_accepted INTEGER NOT NULL CHECK(privacy_accepted=1),'+
    'age_14_confirmed INTEGER NOT NULL CHECK(age_14_confirmed=1),'+
    'marketing_accepted INTEGER NOT NULL DEFAULT 0 CHECK(marketing_accepted IN (0,1)),'+
    'consent_context TEXT NOT NULL,'+
    "accepted_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
}
export function signupConsentInsert(db:D1Database,email:string,consent:V5RegistrationConsent):D1PreparedStatement{
  return db.prepare(
    'INSERT INTO v5_signup_consents(user_id,terms_accepted,privacy_accepted,age_14_confirmed,marketing_accepted,consent_context) '+
    'SELECT id,1,1,1,?,? FROM users WHERE email=?'
  ).bind(consent.marketing?1:0,'v5-public-registration-20261030',email);
}

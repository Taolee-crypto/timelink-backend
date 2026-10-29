export const CONSENT_FORM_VERSION='v5-signup-20261029';
export function validateRegistrationConsent(v:any){
  if(v?.age_14_confirmed!==true || v?.terms_accepted!==true || v?.privacy_accepted!==true) {
    return {ok:false,code:'REQUIRED_CONSENT_MISSING'};
  }
  return {ok:true,marketing:v.marketing===true,version:CONSENT_FORM_VERSION};
}

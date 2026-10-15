// A valid /trial/signup body (as the website form sends it), with overrides.
export const form = (fields = {}) => ({ business: "O'Brien & Sons Plumbing", owner_name: 'Pat Obrien', owner_cell: '(720) 555-0144', office_email: 'Office@OBrien.example',
  shop_number: '720-555-0155', city: 'Denver', state: 'co', services: 'Drain cleaning, water heaters, repiping', not_offered: 'Septic systems',
  emergency_rules: 'Burst pipes 24/7', never_say: 'Never promise same-day service', hours: 'Mon-Fri 7am-5pm', sms_consent: true, terms_accepted: true, website: '', ...fields });

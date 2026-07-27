import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
  try {
    const { data, error } = await supabase.from('salons').select('id').limit(1);
    if (error) {
      console.error('Supabase error:', error);
      process.exit(2);
    }
    console.log('Success — sample row:', data);
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(3);
  }
}

run();

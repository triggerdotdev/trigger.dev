-- Create your word arrays
DO $$
DECLARE 
  first_part text[] := ARRAY[
  'apple', 'banana', 'cherry', 'date', 'elderberry', 
  'fig', 'grape', 'honeydew', 'imbe', 'jackfruit', 
  'kumquat', 'lemon', 'mango', 'nectarine', 'orange', 
  'papaya', 'quince', 'raspberry', 'strawberry', 'tangerine', 
  'ugli', 'valencia', 'watermelon', 'xigua', 'yellowfruit', 
  'avocado', 'bean', 'carrot', 'daikon', 'endive', 
  'fennel', 'gourd', 'horseradish', 'iceplant', 'jalapeno', 
  'kale', 'lettuce', 'mushroom', 'nectar', 'onion', 
  'pea', 'quinoa', 'rutabaga', 'starfruit', 'tomato', 
  'uplandcress', 'voavanga', 'watercress', 'ximenia', 'yam'
];

second_part text[] := ARRAY[
  'zebra', 'anteater', 'buffalo', 'cheetah', 'dolphin',
  'elephant', 'flamingo', 'giraffe', 'horse', 'ibis',
  'jaguar', 'koala', 'lion', 'meerkat', 'numbat',
  'ocelot', 'penguin', 'quokka', 'rhinoceros', 'shark',
  'toucan', 'unicorn', 'viper', 'walrus', 'xenops',
  'yak', 'zebu', 'armadillo', 'bat', 'chameleon',
  'dingo', 'emu', 'fox', 'gorilla', 'hedgehog',
  'impala', 'jellyfish', 'kudu', 'llama', 'mongoose',
  'narwhal', 'octopus', 'panther', 'quail', 'rat',
  'squirrel', 'tiger', 'urchin', 'vulture', 'wombat',
  'xerus', 'yellowtail', 'zebrafish'
];

BEGIN
  -- Add the shortcode column to RuntimeEnvironment
  ALTER TABLE "RuntimeEnvironment"
  ADD COLUMN "shortcode" text;

  -- Populate the shortcode column
  UPDATE "RuntimeEnvironment"
  SET "shortcode" = (
    first_part[floor(random()*(array_length(first_part,1) - 1 + 1) + 1)] || '-' || 
    second_part[floor(random()*(array_length(second_part,1) - 1 + 1) + 1)]  || '-' || 
    SUBSTRING(MD5(RANDOM()::text), 1, 6)
  );

  -- Add uniqueness constraint
  CREATE UNIQUE INDEX "RuntimeEnvironment_projectId_shortcode_key" ON "RuntimeEnvironment"("projectId", "shortcode");
END $$;
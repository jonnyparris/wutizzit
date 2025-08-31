const ADJECTIVES = [
  'Sneezy', 'Giggly', 'Wobbly', 'Bouncy', 'Silly', 'Grumpy', 'Sleepy', 'Dizzy',
  'Fuzzy', 'Sparkly', 'Goofy', 'Quirky', 'Zany', 'Wacky', 'Bonkers', 'Loopy',
  'Nutty', 'Bizarre', 'Peculiar', 'Odd', 'Weird', 'Strange', 'Funky', 'Wild',
  'Crazy', 'Mad', 'Hyper', 'Jumpy', 'Jiggly', 'Wiggly', 'Squiggly', 'Bubbly'
];

const NOUNS = [
  'Banana', 'Pickle', 'Waffle', 'Muffin', 'Cookie', 'Donut', 'Pancake', 'Taco',
  'Burrito', 'Sandwich', 'Pretzel', 'Bagel', 'Cupcake', 'Brownie', 'Nugget',
  'Chicken', 'Turkey', 'Lobster', 'Shrimp', 'Octopus', 'Penguin', 'Flamingo',
  'Unicorn', 'Dragon', 'Wizard', 'Ninja', 'Pirate', 'Robot', 'Alien', 'Monster',
  'Dinosaur', 'Hamster', 'Sloth', 'Llama', 'Potato', 'Carrot', 'Broccoli'
];

export function generateRandomName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const number = Math.floor(Math.random() * 100) + 1;
  
  return `${adjective}${noun}${number}`;
}
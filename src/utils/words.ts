export const WORDS = [
  // Basic words
  'cat', 'dog', 'house', 'tree', 'car', 'sun', 'moon', 'star', 'fish', 'bird',
  'apple', 'banana', 'flower', 'mountain', 'ocean', 'river', 'cloud', 'rain',
  'book', 'chair', 'table', 'phone', 'computer', 'pizza', 'cake', 'cookie',
  'bicycle', 'plane', 'boat', 'train', 'guitar', 'piano', 'ball', 'hat',
  'shoe', 'shirt', 'pants', 'glasses', 'watch', 'key', 'door', 'window',
  'bridge', 'castle', 'tower', 'garden', 'forest', 'beach', 'desert', 'island',
  
  // Animals
  'elephant', 'giraffe', 'penguin', 'dolphin', 'shark', 'butterfly', 'spider', 'snake',
  'tiger', 'lion', 'bear', 'wolf', 'fox', 'rabbit', 'squirrel', 'owl', 'eagle',
  'flamingo', 'parrot', 'turtle', 'frog', 'octopus', 'jellyfish', 'whale', 'crab',
  
  // Food & Drink
  'hamburger', 'hotdog', 'sandwich', 'taco', 'sushi', 'pasta', 'salad', 'soup',
  'ice cream', 'donut', 'muffin', 'pancake', 'waffle', 'cheese', 'bread', 'egg',
  'coffee', 'tea', 'juice', 'soda', 'milkshake', 'smoothie', 'water', 'wine',
  
  // Movies & TV Shows
  'batman', 'superman', 'spiderman', 'ironman', 'hulk', 'thor', 'captain america',
  'wonder woman', 'joker', 'darth vader', 'yoda', 'luke skywalker', 'princess leia',
  'harry potter', 'hermione', 'dumbledore', 'voldemort', 'gandalf', 'frodo',
  'shrek', 'donkey', 'fiona', 'elsa', 'anna', 'olaf', 'simba', 'timon', 'pumbaa',
  'woody', 'buzz lightyear', 'nemo', 'dory', 'mickey mouse', 'donald duck',
  'homer simpson', 'bart simpson', 'spongebob', 'patrick star', 'pikachu', 'ash',
  
  // Video Games
  'mario', 'luigi', 'bowser', 'princess peach', 'yoshi', 'link', 'zelda', 'ganondorf',
  'sonic', 'tails', 'knuckles', 'pac man', 'tetris', 'minecraft', 'fortnite',
  'pokemon', 'master chief', 'kratos', 'lara croft', 'ryu', 'chun li',
  
  // Music & Artists
  'guitar', 'drums', 'microphone', 'headphones', 'concert', 'stage', 'amplifier',
  'vinyl record', 'cd player', 'boom box', 'karaoke', 'disco ball', 'dj turntable',
  
  // Sports
  'football', 'basketball', 'baseball', 'soccer ball', 'tennis racket', 'golf club',
  'skateboard', 'surfboard', 'ski', 'hockey stick', 'boxing gloves', 'trophy',
  'olympics', 'stadium', 'referee', 'cheerleader', 'coach', 'marathon',
  
  // Technology
  'smartphone', 'laptop', 'tablet', 'headphones', 'camera', 'television', 'robot',
  'satellite', 'rocket', 'drone', 'virtual reality', 'joystick', 'keyboard', 'mouse',
  'wifi', 'bluetooth', 'usb cable', 'hard drive', 'processor', 'battery',
  
  // Places & Travel
  'airport', 'hotel', 'restaurant', 'hospital', 'school', 'library', 'museum',
  'zoo', 'park', 'mall', 'church', 'mosque', 'temple', 'pyramid', 'statue of liberty',
  'eiffel tower', 'big ben', 'great wall', 'mount everest', 'grand canyon',
  'taj mahal', 'colosseum', 'stonehenge', 'niagara falls', 'golden gate bridge',
  
  // Professions
  'doctor', 'teacher', 'firefighter', 'police officer', 'chef', 'pilot', 'astronaut',
  'scientist', 'artist', 'musician', 'actor', 'writer', 'photographer', 'nurse',
  'mechanic', 'farmer', 'fisherman', 'mailman', 'judge', 'lawyer',
  
  // Clothing & Fashion
  'dress', 'suit', 'tie', 'scarf', 'gloves', 'boots', 'sandals', 'sneakers',
  'backpack', 'purse', 'sunglasses', 'jewelry', 'necklace', 'bracelet', 'earrings',
  'ring', 'belt', 'jacket', 'coat', 'umbrella',
  
  // Weather & Nature
  'lightning', 'thunder', 'rainbow', 'tornado', 'hurricane', 'snowflake', 'icicle',
  'volcano', 'earthquake', 'avalanche', 'waterfall', 'geyser', 'coral reef',
  'northern lights', 'meteor', 'constellation', 'black hole', 'solar system',
  
  // Holidays & Celebrations
  'christmas tree', 'santa claus', 'reindeer', 'snowman', 'jack o lantern',
  'ghost', 'witch', 'vampire', 'zombie', 'skeleton', 'birthday cake', 'candles',
  'fireworks', 'party hat', 'balloon', 'confetti', 'graduation cap', 'wedding dress',
  
  // Fairy Tales & Fantasy
  'dragon', 'unicorn', 'fairy', 'wizard', 'witch', 'magic wand', 'crystal ball',
  'castle', 'knight', 'sword', 'shield', 'crown', 'treasure chest', 'pirate ship',
  'mermaid', 'genie', 'flying carpet', 'golden egg', 'magic lamp', 'potion',
  
  // Emotions & Actions
  'happy', 'sad', 'angry', 'surprised', 'scared', 'excited', 'sleeping', 'running',
  'jumping', 'dancing', 'singing', 'laughing', 'crying', 'thinking', 'dreaming',
  'flying', 'swimming', 'climbing', 'cooking', 'reading'
];

export function getRandomWord(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

export function isWordMatch(guess: string, word: string): boolean {
  return guess.toLowerCase().trim() === word.toLowerCase().trim();
}
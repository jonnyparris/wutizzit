export const WORDS = [
  'cat', 'dog', 'house', 'tree', 'car', 'sun', 'moon', 'star', 'fish', 'bird',
  'apple', 'banana', 'flower', 'mountain', 'ocean', 'river', 'cloud', 'rain',
  'book', 'chair', 'table', 'phone', 'computer', 'pizza', 'cake', 'cookie',
  'bicycle', 'plane', 'boat', 'train', 'guitar', 'piano', 'ball', 'hat',
  'shoe', 'shirt', 'pants', 'glasses', 'watch', 'key', 'door', 'window',
  'bridge', 'castle', 'tower', 'garden', 'forest', 'beach', 'desert', 'island'
];

export function getRandomWord(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

export function isWordMatch(guess: string, word: string): boolean {
  return guess.toLowerCase().trim() === word.toLowerCase().trim();
}
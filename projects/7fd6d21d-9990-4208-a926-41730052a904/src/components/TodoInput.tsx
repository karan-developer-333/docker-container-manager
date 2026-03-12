import { useState } from 'react';
import { motion } from 'framer-motion';

type TodoInputProps = {
  onAdd: (text: string) => void;
};

export default function TodoInput({ onAdd }: TodoInputProps) {
  const [text, setText] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) {
      onAdd(text);
      setText('');
    }
  };

  return (
    <motion.form
      onSubmit={handleSubmit}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex gap-4 mb-8"
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What needs to be done?"
        className="flex-1 px-4 py-3 bg-gray-800/50 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-400 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/50 transition-all"
      />
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        type="submit"
        className="px-6 py-3 bg-primary text-gray-900 font-bold rounded-lg hover:bg-primary/90 transition-all"
      >
        Add
      </motion.button>
    </motion.form>
  );
}
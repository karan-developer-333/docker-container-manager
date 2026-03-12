import { motion } from 'framer-motion';
import { Todo } from '../types';
import { Check, X } from 'lucide-react';

interface TodoItemProps {
  todo: Todo;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
  index: number;
}

export default function TodoItem({ todo, onToggle, onDelete, index }: TodoItemProps) {
  return (
    <motion.li
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -100 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex items-center justify-between p-4 rounded-lg bg-black/30 border border-white/10 mb-3 last:mb-0 hover:bg-black/50 transition-all duration-300"
    >
      <div className="flex items-center gap-4">
        <button
          onClick={() => onToggle(todo.id)}
          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all duration-300 ${
            todo.completed
              ? 'border-primary bg-primary/20'
              : 'border-white/30 hover:border-primary'
          }`}
        >
          {todo.completed && <Check size={16} className="text-primary" />}
        </button>
        <span
          className={`text-lg transition-all duration-300 ${
            todo.completed ? 'text-white/50 line-through' : 'text-text'
          }`}
        >
          {todo.text}
        </span>
      </div>

      <button
        onClick={() => onDelete(todo.id)}
        className="text-white/30 hover:text-red-400 transition-colors duration-300 p-1 rounded-full hover:bg-red-400/10"
      >
        <X size={20} />
      </button>
    </motion.li>
  );
}
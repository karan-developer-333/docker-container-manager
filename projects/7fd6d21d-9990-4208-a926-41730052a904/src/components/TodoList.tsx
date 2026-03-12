import { motion } from 'framer-motion';
import TodoItem from './TodoItem';
import { Todo } from '../types';

interface TodoListProps {
  todos: Todo[];
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
}

export default function TodoList({ todos, onToggle, onDelete }: TodoListProps) {
  if (todos.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="text-center text-white/50 py-8"
      >
        No tasks yet. Add one above!
      </motion.div>
    );
  }

  return (
    <motion.ul
      initial="hidden"
      animate="visible"
      variants={{
        hidden: { opacity: 0 },
        visible: {
          opacity: 1,
          transition: {
            staggerChildren: 0.1
          }
        }
      }}
      className="mt-6"
    >
      {todos.map((todo, index) => (
        <TodoItem
          key={todo.id}
          todo={todo}
          onToggle={onToggle}
          onDelete={onDelete}
          index={index}
        />
      ))}
    </motion.ul>
  );
}
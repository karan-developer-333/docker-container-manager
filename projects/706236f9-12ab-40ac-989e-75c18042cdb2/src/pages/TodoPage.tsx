import { useState, useEffect } from 'react';
import { Todo } from '../types';
import TodoInput from '../components/TodoInput';
import TodoList from '../components/TodoList';
import { loadTodos, saveTodos } from '../utils/storage';
import { AnimatePresence } from 'framer-motion';

export default function TodoPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [animationKey, setAnimationKey] = useState(0);

  useEffect(() => {
    setTodos(loadTodos());
  }, []);

  useEffect(() => {
    saveTodos(todos);
  }, [todos]);

  const addTodo = (text: string) => {
    const newTodo: Todo = {
      id: Date.now(),
      text,
      completed: false,
    };
    setTodos([...todos, newTodo]);
    setAnimationKey(prev => prev + 1);
  };

  const toggleTodo = (id: number) => {
    setTodos(todos.map(todo =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    ));
  };

  const deleteTodo = (id: number) => {
    setTodos(todos.filter(todo => todo.id !== id));
  };

  return (
    <div className="min-h-screen bg-background text-text font-syne">
      <div className="container mx-auto px-4 py-16 max-w-2xl">
        <h1 className="text-5xl font-bold text-center mb-12 text-primary glow">
          Neon Tasks
        </h1>

        <div className="bg-black/20 backdrop-blur-sm rounded-2xl p-8 border border-white/10 shadow-2xl shadow-primary/10">
          <TodoInput onAdd={addTodo} />

          <AnimatePresence mode="wait">
            <TodoList
              key={animationKey}
              todos={todos}
              onToggle={toggleTodo}
              onDelete={deleteTodo}
            />
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
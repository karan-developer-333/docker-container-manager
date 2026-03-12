import { Todo } from '../types';

const STORAGE_KEY = 'neon-tasks';

export const loadTodos = (): Todo[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

export const saveTodos = (todos: Todo[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
};
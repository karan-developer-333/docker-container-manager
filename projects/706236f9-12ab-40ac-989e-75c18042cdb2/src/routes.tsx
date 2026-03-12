import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import TodoPage from './pages/TodoPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <TodoPage />,
  },
]);

const Routes = () => {
  return <RouterProvider router={router} />;
};

export default Routes;
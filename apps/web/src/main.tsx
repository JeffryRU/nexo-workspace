import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { render } from 'solid-js/web'
import { App } from './App.tsx'

const queryClient = new QueryClient()
const root = document.getElementById('root')
if (root === null) throw new Error('falta el elemento #root')

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  ),
  root,
)

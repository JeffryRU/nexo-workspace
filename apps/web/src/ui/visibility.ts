import { type Accessor, createContext, useContext } from 'solid-js'

/** Si la pestaña que contiene el árbol está a la vista (su espacio y ella están activos). */
export const VisibilityContext = createContext<Accessor<boolean>>(() => true)
export const useVisible = () => useContext(VisibilityContext)

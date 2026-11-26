/**
 * Ruta relativa a la carpeta de la sesión (`cwd`) si está dentro de ella; si no, la original. ACP da rutas
 * absolutas; mostrarlas relativas evita `a/home/usuario/proyecto/src/a.ts` en los diffs. Se hace en el adaptador
 * (no en la vista) para que todos los clientes reciban la misma ruta; las de fuera de la carpeta no se tocan.
 */
export function relativeTo(cwd: string | undefined, file: string): string {
  if (cwd === undefined || cwd === '') return file
  const norm = (p: string) => p.replace(/\\/g, '/')
  const base = norm(cwd).replace(/\/+$/, '')
  const f = norm(file)
  if (base === '') return file
  // En Windows (letra de unidad) las rutas no distinguen mayúsculas.
  const windows = /^[A-Za-z]:(\/|$)/.test(base)
  const a = windows ? f.toLowerCase() : f
  const b = windows ? base.toLowerCase() : base
  return a.startsWith(`${b}/`) && f.length > base.length + 1 ? f.slice(base.length + 1) : file
}

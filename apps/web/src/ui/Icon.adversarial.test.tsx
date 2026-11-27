import { render } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { Icon, type IconName } from './Icon.tsx'

describe('Icon (adversarial)', () => {
  it('nombres hostiles, enormes o de prototipo no inyectan marcado ni lanzan', () => {
    const hostile = [
      '__proto__',
      'constructor',
      'toString',
      '"><img src=x onerror=1>',
      '<script>',
      'x'.repeat(100_000),
      '',
    ]
    for (const name of hostile) {
      const { container, unmount } = render(() => <Icon name={name as IconName} />)
      expect(container.querySelectorAll('img, script').length).toBe(0)
      expect(container.querySelector('svg')).not.toBeNull()
      unmount()
    }
  })

  it('cientos de iconos a la vez se montan sin problema', () => {
    const { container } = render(() => (
      <div>
        {Array.from({ length: 500 }, (_, i) => (
          <Icon name={i % 2 === 0 ? 'plus' : 'x'} size="sm" />
        ))}
      </div>
    ))
    expect(container.querySelectorAll('svg').length).toBe(500)
  })
})

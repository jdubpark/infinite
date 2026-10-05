"""Exercise real browser login, steering, disconnect and responsive layouts.

Run against `npm run dev`, or set --origin and --keys for a commissioned host.
Requires Python Playwright. Keys are never printed. Only the demo provider is used.
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--origin', default='http://127.0.0.1:4780')
parser.add_argument('--keys', type=Path, default=root / '.local/devices.json')
parser.add_argument('--output', type=Path, default=root / '.impeccable/review')
args = parser.parse_args()
keys = json.loads(args.keys.read_text())
out = args.output
out.mkdir(parents=True, exist_ok=True)
origin = args.origin.rstrip('/')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    desktop = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = desktop.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(origin)
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name='Pick up where you left off.')).to_be_visible()
    page.get_by_label('Device key', exact=True).fill(keys['owner'])
    page.get_by_role('button', name='Connect to Infinite').click()
    page.get_by_role('button', name='New session', exact=True).click()
    page.get_by_label('Agent', exact=True).select_option('demo')
    page.get_by_label('Session name', exact=True).fill('Flight-mode rehearsal')
    page.get_by_label('First request', exact=False).fill('Keep recording while my laptop is disconnected.')
    page.get_by_role('button', name='Start session', exact=True).click()
    expect(page.get_by_role('heading', name='Flight-mode rehearsal')).to_be_visible()
    expect(page.locator('.screen')).to_contain_text('Process', timeout=15000)
    pid = page.locator('.session-meta').inner_text()
    page.get_by_label('Message to agent').fill('Keep this exact process running. I will reconnect shortly.')
    page.get_by_role('button', name='Send message', exact=True).click()
    expect(page.locator('.screen')).to_contain_text('You: Keep this exact process', timeout=10000)
    for index in range(9):
        message = f'Continuity checkpoint {index + 1}: preserve the same session.'
        page.get_by_label('Message to agent').fill(message)
        page.get_by_role('button', name='Send message', exact=True).click()
        expect(page.locator('.screen')).to_contain_text(f'You: {message}', timeout=10000)
    expect(page.locator('.screen')).not_to_contain_text('Initial request:')
    page.screenshot(path=str(out / 'desktop.png'), full_page=True)
    desktop.set_offline(True)
    expect(page.get_by_text('Reconnecting', exact=True)).to_be_visible(timeout=10000)
    expect(page.get_by_role('button', name='Send message', exact=True)).to_be_disabled()
    desktop.set_offline(False)
    expect(page.get_by_text('Connected', exact=True)).to_be_visible(timeout=10000)
    assert page.locator('.session-meta').inner_text() == pid
    page.get_by_role('tab', name='Full terminal', exact=True).click()
    expect(page.locator('.xterm-screen')).to_be_visible()
    page.screenshot(path=str(out / 'terminal.png'), full_page=True)
    page.get_by_role('tab', name='Context', exact=True).click()
    expect(page.get_by_text('Keep recording while my laptop is disconnected.', exact=True)).to_be_visible()
    phone = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, device_scale_factor=1, has_touch=True)
    mobile = phone.new_page()
    mobile.on('pageerror', lambda error: errors.append(str(error)))
    mobile.goto(origin)
    mobile.wait_for_load_state('networkidle')
    mobile.get_by_label('Device key', exact=True).fill(keys['controller'])
    mobile.get_by_role('button', name='Connect to Infinite').click()
    mobile.get_by_role('navigation', name='Sessions').get_by_role('button', name='Flight-mode rehearsal', exact=False).first.click()
    expect(mobile.get_by_role('heading', name='Flight-mode rehearsal')).to_be_visible()
    expect(mobile.locator('.screen')).to_contain_text('You: Continuity checkpoint 9', timeout=10000)
    assert mobile.locator('.session-meta').inner_text() == pid
    mobile.screenshot(path=str(out / 'mobile.png'), full_page=True)
    assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile overflow'
    assert not errors, errors
    print('Browser pass: login, new session, steering, offline/reconnect with same PID, terminal replay, context, controller phone, responsive layout.')
    browser.close()

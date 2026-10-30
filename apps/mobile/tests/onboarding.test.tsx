import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Onboarding } from '../src/components/onboarding';
jest.mock('../src/native-port', () => ({
  legalLinks: () => ({
    version: 'v1',
    terms: 'https://example.com/terms',
    privacy: 'https://example.com/privacy',
    community: 'https://example.com/community',
  }),
}));
test('neutral age selection and document consent are both required', async () => {
  const accept = jest.fn(async () => {});
  const screen = render(<Onboarding accept={accept} />);
  expect(screen.getByRole('image', { name: 'Meetile' })).toBeTruthy();
  fireEvent.press(screen.getByText('はじめる'));
  expect(accept).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('16歳未満'));
  expect(screen.getByText('このアプリは16歳以上の方が対象です。')).toBeTruthy();
  fireEvent.press(screen.getByRole('checkbox'));
  fireEvent.press(screen.getByText('はじめる'));
  expect(accept).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('16歳以上'));
  fireEvent.changeText(screen.getByLabelText('署名'), '人工');
  fireEvent.press(screen.getByText('はじめる'));
  await waitFor(() => expect(accept).toHaveBeenCalledWith('人工'));
});

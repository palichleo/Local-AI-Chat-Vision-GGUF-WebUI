import unittest

from runner.models import ladder


class OutOfMemoryError(RuntimeError):
    pass


class FakeTorch:
    """What the ladder asks of PyTorch: the error of a shortage, and the cache to empty."""

    OutOfMemoryError = OutOfMemoryError

    def __init__(self):
        self.emptied = 0
        self.cuda = self

    def empty_cache(self):
        self.emptied += 1


class SmallerTests(unittest.TestCase):
    def test_the_first_attempt_that_fits_is_the_result(self):
        torch, tried, told = FakeTorch(), [], []

        def attempt(name, fits):
            def run():
                tried.append(name)
                if not fits:
                    raise OutOfMemoryError(name)
                return name

            return run

        attempts = [
            attempt('whole', False),
            attempt('tiles', False),
            attempt('small tiles', True),
            attempt('never', True),
        ]
        self.assertEqual(ladder.smaller(attempts, torch, told.append), 'small tiles')
        self.assertEqual(tried, ['whole', 'tiles', 'small tiles'])
        self.assertEqual(told, [1, 2])
        # What a failed attempt held is given back before the next one.
        self.assertEqual(torch.emptied, 2)
        # The first fits: nothing else is tried, nothing is emptied.
        torch, tried = FakeTorch(), []
        self.assertEqual(ladder.smaller([attempt('whole', True), attempt('tiles', True)], torch), 'whole')
        self.assertEqual((tried, torch.emptied), (['whole'], 0))

    def test_the_error_of_the_last_attempt_is_the_callers_and_another_error_is_not_retried(self):
        def lacking():
            raise OutOfMemoryError('too large')

        with self.assertRaises(OutOfMemoryError):
            ladder.smaller([lacking, lacking], FakeTorch())
        tried = []

        def broken():
            tried.append(1)
            raise ValueError('a bug, not a shortage')

        with self.assertRaises(ValueError):
            ladder.smaller([broken, broken], FakeTorch())
        self.assertEqual(tried, [1])


class InPiecesTests(unittest.TestCase):
    def run_with(self, length, most, unit=1, first=None):
        """Pieces of at most `most` fit: the pieces that ran, in their order."""
        ran = []

        def run(start, stop):
            if stop - start > most:
                raise OutOfMemoryError('too large')
            ran.append((start, stop))

        count = ladder.in_pieces(run, length, FakeTorch(), unit=unit, first=first)
        self.assertEqual(count, len(ran))
        return ran

    def test_the_whole_length_is_covered_once_in_pieces_that_fit(self):
        cases = ((1000, 1000, 1, None), (1000, 300, 1, None), (1000, 130, 128, 512), (77, 5, 4, None))
        for length, most, unit, first in cases:
            with self.subTest(length=length, most=most, unit=unit):
                ran = self.run_with(length, most, unit, first)
                self.assertEqual(ran[0][0], 0)
                self.assertEqual(ran[-1][1], length)
                joined = all(before[1] == after[0] for before, after in zip(ran, ran[1:]))
                self.assertTrue(joined, 'no gap, nothing twice')
                self.assertTrue(all(stop - start <= most for start, stop in ran))
                # Every piece but the last is a whole number of units.
                self.assertTrue(all((stop - start) % unit == 0 for start, stop in ran[:-1]))

    def test_one_piece_when_it_fits_and_halves_when_it_does_not(self):
        self.assertEqual(self.run_with(1000, 1000), [(0, 1000)])
        self.assertEqual(self.run_with(1000, 500), [(0, 500), (500, 1000)])
        # A first size asked for: the whole is not even tried.
        self.assertEqual(self.run_with(1024, 2000, unit=128, first=512), [(0, 512), (512, 1024)])

    def test_a_piece_that_ran_is_not_run_again_when_a_later_one_lacks(self):
        ran, room = [], [400, 400, 100, 100, 100, 100]

        def run(start, stop):
            if stop - start > room[len(ran)]:
                raise OutOfMemoryError('too large')
            ran.append((start, stop))

        ladder.in_pieces(run, 1000, FakeTorch(), first=400)
        self.assertEqual(ran, [(0, 400), (400, 800), (800, 900), (900, 1000)])

    def test_the_smallest_piece_that_does_not_fit_is_the_callers_error(self):
        with self.assertRaises(OutOfMemoryError):
            self.run_with(1000, 100, unit=128)


if __name__ == '__main__':
    unittest.main()

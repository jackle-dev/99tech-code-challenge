// Implementation A: Gaussian formula — O(1) time, O(1) space
// Uses the closed-form arithmetic series formula: n*(n+1)/2
export function sum_to_n_a(n: number): number {
  return (n * (n + 1)) / 2;
}

// Implementation B: Iterative loop — O(n) time, O(1) space
export function sum_to_n_b(n: number): number {
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    sum += i;
  }
  return sum;
}

// Implementation C: Recursive — O(n) time, O(n) space (call stack)
export function sum_to_n_c(n: number): number {
  if (n <= 0) return 0;
  return n + sum_to_n_c(n - 1);
}
